import http from 'node:http';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGrooveServer } from '../dist/server.js';
import { uploadAttachments } from '../dist/tools/attachments.js';

const TOKEN = 'test-token';
const page = { hasNextPage: false, endCursor: null };
const contact = { id: 'co_1', email: 'a@example.com', name: 'A', conversationCount: 0, createdAt: '2020-01-01T00:00:00Z' };

// Names resolve offline: to a public address, unless a test sets something else in resolved
const realDns = { ...dns.promises };
let resolved = {};
dns.promises.lookup = async name => {
  const addresses = resolved[name] ?? ['93.184.216.34'];
  if (addresses instanceof Error) throw addresses;
  return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};
afterAll(() => Object.assign(dns.promises, realDns));

// A stand-in for Groove that records what reaches it. Nothing here uses the network
let requests = [];
let answer = () => undefined;
let api;
let url;

function respond(query) {
  const field = query.match(/\{\s*(\w+)\s*[({]/)?.[1];
  if (query.trim().startsWith('mutation')) {
    return { data: { [field]: { conversation: { id: 'cnv_1' }, target: { id: 'cnv_1' }, contact, errors: [] } } };
  }
  const data = {
    conversation: { id: 'cnv_1' },
    node: { id: 'cnv_1', number: 1, state: 'OPENED', contact, channel: { id: 'ch_1' } },
    contacts: { nodes: [contact], pageInfo: page, totalCount: 1 },
    drafts: { nodes: [], pageInfo: page },
    me: { id: 'ag_1', email: 'a@example.com' },
  };
  return { data: { [field]: data[field] ?? null } };
}

beforeAll(async () => {
  api = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body || '{}');
      const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      const isMutation = query.trim().startsWith('mutation');
      requests.push({ operation, isMutation, variables });
      const custom = answer(query, res);
      if (custom === 'handled') return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(custom ?? respond(query)));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${api.address().port}/graphql`;
});

afterAll(() => new Promise(resolve => api.close(resolve)));

async function connect(options = {}) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createGrooveServer({ token: TOKEN, apiUrl: url, ...options }).connect(serverSide);
  const client = new Client({ name: 'security-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(options, name, args) {
  requests = [];
  answer = call.answer ?? (() => undefined);
  const client = await connect(options);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return {
    isError: result.isError,
    text: result.content[0].text,
    mutations: requests.filter(request => request.isMutation).map(request => request.operation),
  };
}

const note = { conversationId: '1', body: 'b' };
const log = { channelId: 'ch_1', to: 'a@example.com', subject: 's', body: 'b' };
const byUrl = [{ fileName: 'a.txt', url: 'https://example.com/a?data=secret' }];

describe('attachments are off by default', () => {
  let downloads;
  const realFetch = globalThis.fetch;
  const byBase64 = [{ fileName: 'a.txt', contentBase64: 'eA==' }];

  beforeAll(() => {
    globalThis.fetch = (target, init) => {
      if (String(target).startsWith('https://example.com')) {
        downloads++;
        return Promise.resolve(new Response('x'));
      }
      if (String(target).endsWith('/upload')) return Promise.resolve(new Response(null, { status: 204 }));
      return realFetch(target, init);
    };
    call.answer = query => {
      if (query.includes('uploadPayloadGenerate')) {
        return { data: { uploadPayloadGenerate: { key: 'k', request: { method: 'POST', url: `${url}/upload`, data: [] } } } };
      }
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    call.answer = undefined;
  });

  test.each([
    ['createNote', note, byUrl],
    ['createNote', note, byBase64],
    ['logConversation', log, byUrl],
    ['logConversation', log, byBase64],
  ])('%s refuses them', async (tool, args, attachments) => {
    downloads = 0;
    const result = await call({}, tool, { ...args, attachments });
    expect(downloads).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test('a mail with a file is refused, not sent without it', async () => {
    const result = await call({ allowSend: true }, 'sendMessage', {
      conversationId: '1', to: 'a@example.com', body: 'b', attachments: byUrl,
    });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test('no tool offers them', async () => {
    const client = await connect({ allowSend: true });
    const { tools } = await client.listTools();
    for (const tool of tools) expect(tool.inputSchema.properties?.attachments).toBeUndefined();
    await client.close();
  });

  test('read-only wins', async () => {
    const client = await connect({ allowAttachments: true, readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.some(tool => tool.inputSchema.properties?.attachments)).toBe(false);
    await client.close();
  });

  test.each([['a link', byUrl], ['base64', byBase64]])('%s works when turned on', async (_, attachments) => {
    const result = await call({ allowAttachments: true }, 'createNote', { ...note, attachments });
    expect(result.mutations).toContain('ConversationAddNote');
  });

  test('sending stays separate from attachments', async () => {
    const client = await connect({ allowAttachments: true });
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'sendMessage')).toBeUndefined();
    expect(tools.find(tool => tool.name === 'createNote').inputSchema.properties.attachments).toBeDefined();
    await client.close();
  });
});

describe('spam', () => {
  test('markAsSpam marks a ticket', async () => {
    expect((await call({}, 'markAsSpam', { id: '1' })).mutations).toEqual(['ConversationSpam']);
  });

  test('markAsSpam is gone in read-only mode', async () => {
    expect((await call({ readOnly: true }, 'markAsSpam', { id: '1' })).mutations).toEqual([]);
  });

  test.each(['spam', 'SPAM', 'Spam'])('updateConversation refuses state %s', async state => {
    const result = await call({}, 'updateConversation', { id: '1', state, tagIds: ['t1'] });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

});

describe('restoring tickets', () => {
  const history = states => ({
    data: {
      events: {
        nodes: states.map((to, index) => ({ createdAt: `2026-01-0${index + 1}T00:00:00Z`, change: { to } })),
        pageInfo: page,
      },
    },
  });
  const restore = async (states, args = {}) => {
    call.answer = query => (query.includes('ListStateChanges') ? history(states) : undefined);
    const result = await call({}, 'restoreConversation', { id: '1', ...args });
    call.answer = undefined;
    return { result, newState: requests.find(request => request.isMutation)?.variables.input.newState };
  };

  test.each([
    [['OPENED', 'CLOSED'], 'CLOSED'],
    [['OPENED'], 'OPENED'],
    [['OPENED', 'UNREAD'], 'UNREAD'],
    [['OPENED', 'CLOSED', 'SPAM'], 'CLOSED'],
    [['OPENED', 'SNOOZED'], 'OPENED'],
    [[], 'OPENED'],
  ])('history %j restores as %s', async (states, expected) => {
    expect((await restore(states)).newState).toBe(expected);
  });

  test('history comes back newest last or first, the newest counts', async () => {
    const shuffled = [
      { createdAt: '2026-01-03T00:00:00Z', change: { to: 'CLOSED' } },
      { createdAt: '2026-01-01T00:00:00Z', change: { to: 'OPENED' } },
    ];
    call.answer = query => (query.includes('ListStateChanges') ? { data: { events: { nodes: shuffled, pageInfo: page } } } : undefined);
    await call({}, 'restoreConversation', { id: '1' });
    call.answer = undefined;
    expect(requests.find(request => request.isMutation).variables.input.newState).toBe('CLOSED');
  });

  test.each(['spam', 'SPAM'])('a state of %s is ignored', async state => {
    expect((await restore(['OPENED', 'CLOSED'], { state })).newState).toBe('CLOSED');
  });

  test('offers no state', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'restoreConversation').inputSchema.properties.state).toBeUndefined();
    await client.close();
  });

  test('a ticket stays deleted when the history cannot be read', async () => {
    call.answer = query => (query.includes('ListStateChanges') ? { errors: [{ message: 'history failed' }] } : undefined);
    const result = await call({}, 'restoreConversation', { id: '1' });
    call.answer = undefined;
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });
});

describe('deleting tickets', () => {
  const mode = () => requests.find(request => request.isMutation)?.variables.input.deleteMode;

  test('deleteConversation can be restored', async () => {
    const result = await call({}, 'deleteConversation', { id: '1' });
    expect(result.isError).toBeUndefined();
    expect(mode()).toBe('SOFT');
  });

  test.each([true, 'true', 1])('deleteConversation ignores permanent %j', async permanent => {
    await call({ allowPermanentDelete: true }, 'deleteConversation', { id: '1', permanent });
    expect(mode()).toBe('SOFT');
  });

  test('deleteConversation offers no permanent option', async () => {
    const client = await connect({ allowPermanentDelete: true });
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'deleteConversation').inputSchema.properties.permanent).toBeUndefined();
    await client.close();
  });

  test('deleteConversationPermanently is off by default', async () => {
    const result = await call({}, 'deleteConversationPermanently', { id: '1' });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
    expect(result.text).toContain('GROOVE_ALLOW_PERMANENT_DELETE=1');
  });

  test('read-only wins over permanent deletion', async () => {
    const result = await call({ readOnly: true, allowPermanentDelete: true }, 'deleteConversationPermanently', { id: '1' });
    expect(result.mutations).toEqual([]);
  });

  test('deleteConversationPermanently deletes for good when allowed', async () => {
    await call({ allowPermanentDelete: true }, 'deleteConversationPermanently', { id: '1' });
    expect(mode()).toBe('HARD');
  });

  test.each(['trashed', 'TRASHED'])('updateConversation refuses state %s', async state => {
    const result = await call({}, 'updateConversation', { id: '1', state, tagIds: ['t1'] });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });
});

describe('safety options', () => {
  test.each(['readOnly', 'allowSend', 'allowSendAs', 'allowMerge', 'allowPermanentDelete', 'allowAttachments', 'readAttachments'])('%s refuses anything but a boolean', option => {
    for (const value of ['true', 'false', '1', 1, 0, null]) {
      expect(() => createGrooveServer({ token: TOKEN, [option]: value })).toThrow('must be true or false');
    }
  });

  function start(env) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, ['dist/index.js'], {
        env: { PATH: process.env.PATH, GROOVE_API_TOKEN: TOKEN, GROOVE_API_URL: url, ...env },
      });
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.includes('started successfully')) child.kill();
      });
      child.on('exit', code => resolve({ code, stderr }));
    });
  }

  test.each([
    ['GROOVE_READ_ONLY', 'true'],
    ['GROOVE_READ_ONLY', ' 1'],
    ['GROOVE_ALLOW_SEND', 'yes'],
    ['GROOVE_ALLOW_SEND_AS', 'on'],
    ['GROOVE_ALLOW_MERGE', 'false'],
    ['GROOVE_ALLOW_PERMANENT_DELETE', 'TRUE'],
    ['GROOVE_ALLOW_ATTACHMENTS', 'true'],
    ['GROOVE_READ_ATTACHMENTS', 'off'],
    ['GROOVE_READ_ONLY', ''],
    ['GROOVE_ALLOW_MERGE', ''],
  ])('%s=%s stops the server', async (name, value) => {
    answer = () => undefined;
    const { code, stderr } = await start({ [name]: value });
    expect(code).toBe(1);
    expect(stderr).toContain(`${name} must be 1 or 0`);
  });

  test('no GROOVE_API_TOKEN stops the server', async () => {
    const { code, stderr } = await start({ GROOVE_API_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('GROOVE_API_TOKEN environment variable is required');
  });

  test.each([['GROOVE_READ_ONLY', '1'], ['GROOVE_ALLOW_MERGE', '0'], ['GROOVE_ALLOW_SEND', '0']])('%s=%s starts', async (name, value) => {
    answer = () => undefined;
    expect((await start({ [name]: value })).stderr).toContain('started successfully');
  });
});

describe('boolean arguments', () => {
  test.each(['false', 'no', '0', 1])('deleteContact with confirm %j deletes nothing', async confirm => {
    const result = await call({}, 'deleteContact', { email: contact.email, confirm });
    expect(result.mutations).toEqual([]);
    expect(result.isError).toBe(true);
  });

  test('deleteContact with confirm true deletes', async () => {
    expect((await call({}, 'deleteContact', { email: contact.email, confirm: true })).mutations).toEqual(['ContactDelete']);
  });

  test.each(['allowDifferentContacts', 'discardDrafts'])('mergeConversations with %s "false" merges nothing', async flag => {
    const result = await call({}, 'mergeConversations', { sourceId: 'cnv_1', targetId: 'cnv_2', [flag]: 'false' });
    expect(result.mutations).toEqual([]);
  });
});

describe('merging tickets without contacts', () => {
  const merge = async (source, target, args = {}) => {
    let reads = 0;
    call.answer = query => {
      if (query.includes('node(')) {
        reads++;
        return { data: { node: { id: `cnv_${reads}`, number: reads, contact: reads === 1 ? source : target, channel: { id: 'ch_1' } } } };
      }
    };
    const result = await call({}, 'mergeConversations', { sourceId: 'cnv_1', targetId: 'cnv_2', ...args });
    call.answer = undefined;
    return result;
  };

  test('two tickets without a contact are refused', async () => {
    const result = await merge(null, null);
    expect(result.mutations).toEqual([]);
    expect(result.text).toContain('no contact');
    expect(result.text).not.toContain('undefined');
  });

  test('one missing contact is refused', async () => {
    expect((await merge(null, contact)).mutations).toEqual([]);
    expect((await merge(contact, null)).mutations).toEqual([]);
  });

  test('the same contact still merges', async () => {
    expect((await merge(contact, contact)).mutations).toEqual(['ConversationMerge']);
  });

  test('allowDifferentContacts still overrides it', async () => {
    expect((await merge(null, null, { allowDifferentContacts: true })).mutations).toEqual(['ConversationMerge']);
  });
});

describe('authorId', () => {
  test.each(['', 0, false])('%j is refused with send-as off', async authorId => {
    const result = await call({}, 'createNote', { ...note, authorId });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test('null counts as left out', async () => {
    expect((await call({}, 'createNote', { ...note, authorId: null })).mutations).toEqual(['ConversationAddNote']);
  });

  test('an empty authorId does not skip the check with send-as on', async () => {
    call.answer = query => (query.includes('agents(') ? { data: { agents: { nodes: [{ id: 'ag_1', state: 'ACTIVE' }], pageInfo: page } } } : undefined);
    const result = await call({ allowSendAs: true }, 'createNote', { ...note, authorId: '' });
    call.answer = undefined;
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });
});

describe('argument types', () => {
  test.each([1000000])('limit %j is passed on, Groove documents no maximum', async limit => {
    await call({}, 'listConversations', { limit });
    expect(requests[0].variables.first).toBe(limit);
  });

  test.each([-1, 0, 1.5, 'abc', '5'])('limit %j is refused', async limit => {
    for (const tool of ['listConversations', 'listContacts', 'listCompanies']) {
      requests = [];
      const result = await call({}, tool, { limit });
      expect(result.isError).toBe(true);
      expect(requests).toEqual([]);
    }
  });

  test('listMessages refuses a negative limit', async () => {
    expect((await call({}, 'listMessages', { conversationId: '1', limit: -2 })).isError).toBe(true);
  });

  test.each([
    ['updateConversation', { id: '1', followerIds: 'ag_1' }],
    ['updateConversation', { id: '1', tagIds: 'tag_1' }],
    ['updateConversation', { id: '1', tagIds: [1] }],
    ['createNote', { conversationId: '1', body: { html: 'x' } }],
    ['listContacts', { olderThanDays: 'old', orphansOnly: true }],
  ])('%s refuses %j', async (tool, args) => {
    const result = await call({}, tool, args);
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test.each(['not an address', 'a@b', 'a b@example.com'])('createContact refuses email %j', async email => {
    const result = await call({}, 'createContact', { email });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test('updateContact refuses a bad email', async () => {
    const result = await call({}, 'updateContact', { id: 'co_1', email: 'not an address' });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });

  test('a plus address is fine', async () => {
    expect((await call({}, 'createContact', { email: 'a+b@example.com' })).mutations).toEqual(['ContactCreate']);
  });
});

describe('contacts without a ticket count', () => {
  beforeAll(() => {
    const unknown = { ...contact, conversationCount: null };
    call.answer = query => {
      if (query.includes('contacts(')) return { data: { contacts: { nodes: [unknown], pageInfo: page, totalCount: 1 } } };
      if (query.includes('node(')) return { data: { node: unknown } };
    };
  });
  afterAll(() => {
    call.answer = undefined;
  });

  test('deleteContact keeps them', async () => {
    const result = await call({}, 'deleteContact', { email: contact.email, confirm: true });
    expect(result.mutations).toEqual([]);
    expect(result.text).toContain('no ticket count');
  });
});

describe('lists that never end', () => {
  const lists = [
    ['listMessages', { conversationId: '1' }, 'events', []],
    ['listDrafts', {}, 'drafts', []],
    ['listAgents', {}, 'agents', []],
    ['listTeams', {}, 'teams', []],
    ['listTags', {}, 'tags', Array.from({ length: 100 }, (_, index) => ({ id: `t${index}` }))],
    ['getAgent', { id: 'ag_1' }, 'agents', []],
  ];

  test.each(lists)('%s stops at a repeated cursor', async (tool, args, field, nodes) => {
    let reads = 0;
    call.answer = query => {
      if (!query.includes(`${field}(`)) return undefined;
      reads++;
      return { data: { [field]: { nodes, pageInfo: { hasNextPage: true, endCursor: 'same' } } } };
    };
    const result = await call({}, tool, args);
    call.answer = undefined;
    expect(reads).toBe(2);
    expect(result.isError).toBe(true);
  });

  test.each(lists)('%s stops after 100 pages', async (tool, args, field, nodes) => {
    let reads = 0;
    call.answer = query => {
      if (!query.includes(`${field}(`)) return undefined;
      reads++;
      return { data: { [field]: { nodes, pageInfo: { hasNextPage: true, endCursor: `c${reads}` } } } };
    };
    const result = await call({}, tool, args);
    call.answer = undefined;
    expect(reads).toBeLessThanOrEqual(100);
    expect(result.isError).toBe(true);
  });
});

describe('errors', () => {
  test('an HTTP error gives the status, not the query or the response', async () => {
    call.answer = (query, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html');
      res.end('<h1>internal detail</h1>');
      return 'handled';
    };
    const result = await call({}, 'listConversations', { keywords: 'customer search' });
    call.answer = undefined;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 500');
    expect(result.text).not.toContain('customer search');
    expect(result.text).not.toContain('internal detail');
    expect(result.text).not.toContain('query');
  });

  test('a merged ticket says where it went', async () => {
    call.answer = () => ({ errors: [{ message: 'merged', extensions: { code: 'RESOURCE_MERGED', new_conversation_id: 'cnv_42' } }] });
    const result = await call({}, 'getConversation', { id: 'cnv_7' });
    call.answer = undefined;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ticket was merged into #42');
  });

  test('a deleted or unknown ticket is reported as such', async () => {
    call.answer = () => ({ errors: [{ message: 'An object of type Conversation is deleted' }] });
    const result = await call({}, 'getConversation', { id: 'cnv_7' });
    call.answer = undefined;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Ticket not found or deleted');
  });

  test('a token that Groove repeats in an error is masked', async () => {
    call.answer = () => ({ errors: [{ message: `Denied for ${TOKEN}` }] });
    const result = await call({}, 'listConversations', {});
    call.answer = undefined;
    expect(result.text).toContain('Denied for [token]');
    expect(result.text).not.toContain(TOKEN);
  });

  test('a token that Groove repeats in a mutation error is masked', async () => {
    call.answer = query => {
      if (query.trim().startsWith('mutation')) {
        return { data: { conversationClose: { errors: [{ message: `Denied for ${TOKEN}` }] } } };
      }
    };
    const result = await call({}, 'closeConversation', { id: '1' });
    call.answer = undefined;
    expect(result.text).toContain('Denied for [token]');
    expect(result.text).not.toContain(TOKEN);
  });

  test('a blocked tool reports an error', async () => {
    const result = await call({}, 'sendMessage', { conversationId: '1', to: 'a@example.com', body: 'b' });
    expect(result.isError).toBe(true);
    expect(result.mutations).toEqual([]);
  });
});

describe('attachment links and sizes', () => {
  const client = { request: () => { throw new Error('reached upload'); } };
  const attempt = (target, attachment) => uploadAttachments(client, [{ fileName: 'a', ...(attachment ?? { url: target }) }]);
  const realFetch = globalThis.fetch;
  let fetched;

  beforeAll(() => {
    globalThis.fetch = target => {
      fetched.push(String(target));
      return Promise.reject(new Error('no network in tests'));
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test.each([
    'localhost', 'localhost.', 'LOCALHOST.', 'foo.localhost.', 'foo.local.', 'foo.internal.', 'metadata.google.internal.',
    'intranet', '127.0.0.1', '127.1', '2130706433', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '[::1]', '[::ffff:127.0.0.1]', '[::7f00:1]',
    '[::127.0.0.1]', '[64:ff9b::7f00:1]', '[fec0::1]', '[fe80::1]', '[fd00::1]', '[2002:7f00:1::]', '[2001:db8::1]',
  ])('https://%s/ is refused', async host => {
    fetched = [];
    await expect(attempt(`https://${host}/`)).rejects.toThrow('not allowed');
    expect(fetched).toEqual([]);
  });

  test.each(['example.com', 'example.com.', '93.184.216.34', '[2606:2800:220:1::1]'])('https://%s/ is tried', async host => {
    fetched = [];
    await expect(attempt(`https://${host}/`)).rejects.toThrow('no network');
    expect(fetched).toHaveLength(1);
  });

  test('a download stops at 20 MB without a content-length', async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
      pull(controller) {
        sent++;
        if (sent > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    globalThis.fetch = () => Promise.resolve(new Response(body));
    await expect(attempt('https://example.com/big')).rejects.toThrow('larger than 20 MB');
    expect(sent).toBeLessThan(30);
  });

  test('base64 of exactly 20 MB gets through', async () => {
    const twenty = Buffer.alloc(20 * 1024 * 1024, 97).toString('base64');
    await expect(attempt(null, { contentBase64: twenty })).rejects.toThrow('reached upload');
  });

  test('base64 of 21 MB is refused', async () => {
    const tooBig = Buffer.alloc(21 * 1024 * 1024, 97).toString('base64');
    await expect(attempt(null, { contentBase64: tooBig })).rejects.toThrow('larger than 20 MB');
  });

  test('base64 is measured before it is decoded', async () => {
    const huge = 'A'.repeat(40 * 1024 * 1024);
    const atobSpy = globalThis.atob;
    let decoded = false;
    globalThis.atob = value => {
      decoded = true;
      return atobSpy(value);
    };
    await expect(attempt(null, { contentBase64: huge })).rejects.toThrow('larger than 20 MB');
    globalThis.atob = atobSpy;
    expect(decoded).toBe(false);
  });
});

describe('attachment links by where their name points', () => {
  const client = { request: () => { throw new Error('reached upload'); } };
  const attempt = target => uploadAttachments(client, [{ fileName: 'a', url: target }]);
  const realFetch = globalThis.fetch;
  let fetched;

  beforeAll(() => {
    globalThis.fetch = target => {
      fetched.push(String(target));
      if (String(target).startsWith('https://redirect.example')) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://inside.example/x' } }));
      }
      return Promise.reject(new Error('no network in tests'));
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    resolved = {};
    dns.promises.resolve4 = realDns.resolve4;
    dns.promises.resolve6 = realDns.resolve6;
  });

  test.each([
    ['localhost', ['127.0.0.1']],
    ['a private network', ['10.1.2.3']],
    ['cloud metadata', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['IPv4 inside IPv6', ['::ffff:127.0.0.1']],
    ['one private address among public ones', ['93.184.216.34', '192.168.1.10']],
  ])('a name that points to %s is refused', async (_, addresses) => {
    fetched = [];
    resolved = { 'sneaky.example': addresses };
    await expect(attempt('https://sneaky.example/a')).rejects.toThrow('not allowed');
    expect(fetched).toEqual([]);
  });

  test('a name that points to public addresses is tried', async () => {
    fetched = [];
    resolved = { 'public.example': ['93.184.216.34', '2606:2800:220:1::1'] };
    await expect(attempt('https://public.example/a')).rejects.toThrow('no network');
    expect(fetched).toHaveLength(1);
  });

  test('a name that does not resolve is refused', async () => {
    fetched = [];
    resolved = { 'missing.example': Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) };
    await expect(attempt('https://missing.example/a')).rejects.toThrow("can't be resolved");
    expect(fetched).toEqual([]);
  });

  test('a redirect to a name that points inside is refused', async () => {
    fetched = [];
    resolved = { 'inside.example': ['10.0.0.1'] };
    await expect(attempt('https://redirect.example/a')).rejects.toThrow('not allowed: https://inside.example/x');
    expect(fetched).toEqual(['https://redirect.example/a']);
  });

  describe('without lookup, as in a Worker', () => {
    const lookup = dns.promises.lookup;
    beforeAll(() => {
      dns.promises.lookup = async () => { throw new Error('Not implemented'); };
    });
    afterAll(() => {
      dns.promises.lookup = lookup;
    });

    test('DNS is asked directly and a private answer is refused', async () => {
      fetched = [];
      dns.promises.resolve4 = async () => ['10.0.0.1'];
      dns.promises.resolve6 = async () => { throw Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' }); };
      await expect(attempt('https://worker.example/a')).rejects.toThrow('not allowed');
      expect(fetched).toEqual([]);
    });

    test('a public answer is tried', async () => {
      fetched = [];
      dns.promises.resolve4 = async () => ['93.184.216.34'];
      dns.promises.resolve6 = async () => ['2606:2800:220:1::1'];
      await expect(attempt('https://worker.example/a')).rejects.toThrow('no network');
      expect(fetched).toHaveLength(1);
    });

    test('no answer at all is refused', async () => {
      fetched = [];
      dns.promises.resolve4 = async () => { throw new Error('queryA ENOTFOUND'); };
      dns.promises.resolve6 = async () => { throw new Error('queryAaaa ENOTFOUND'); };
      await expect(attempt('https://worker.example/a')).rejects.toThrow("can't be resolved");
      expect(fetched).toEqual([]);
    });
  });
});
