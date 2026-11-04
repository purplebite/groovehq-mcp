import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGrooveServer } from '../dist/server.js';

// The normal path and the main error of every tool, against a stand-in for Groove.
// Nothing here uses the network
const page = { hasNextPage: false, endCursor: null };
const contact = { id: 'co_1', email: 'a@example.com', name: 'A', conversationCount: 0, createdAt: '2020-01-01T00:00:00Z' };
const channel = { __typename: 'EmailChannel', id: 'ch_1', name: 'Support' };
const ticket = { id: 'cnv_1', number: 1, state: 'OPENED', subject: 'Hello', contact, channel };
const agent = { id: 'ag_1', email: 'agent@example.com', name: 'Agent', state: 'ACTIVE' };
const company = { id: 'cp_1', name: 'Company', domain: 'example.com', conversationCount: 0, customFieldValues: { nodes: [] } };
const article = { id: 'ka_1', title: 'Article', body: 'Text', state: 'PUBLISHED' };
const list = node => ({ nodes: [node], pageInfo: page, totalCount: 1 });

// A node comes back with the ID that was asked for, so two tickets or contacts can differ
const nodes = {
  GetConversation: ticket,
  GetDraftTicket: ticket,
  GetTicketNode: ticket,
  GetContact: contact,
  GetCompany: company,
  GetKbArticle: article,
  GetChannel: channel,
};

let drafts;
let requests = [];
let answer = () => undefined;
let api;
let url;

function respond(query, variables = {}) {
  const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
  const field = query.match(/\{\s*(\w+)\s*[({]/)?.[1];
  if (operation === 'DraftUpsert') {
    const { input } = variables;
    drafts.push({ draftId: input.draftId, draftType: input.draftType, conversationId: input.conversationId, agent, body: 'x' });
  }
  if (query.trim().startsWith('mutation')) {
    return { data: { [field]: { conversation: ticket, target: ticket, contact, errors: [] } } };
  }
  if (field === 'node') {
    const node = nodes[operation];
    return { data: { node: node && { ...node, id: variables.id } } };
  }
  const data = {
    conversation: { id: `cnv_${variables.number}` },
    conversations: list(ticket),
    contacts: list(contact),
    companies: list(company),
    agents: list(agent),
    tags: list({ id: 'tag_1', name: 'tag' }),
    teams: list({ id: 'tm_1', name: 'Team' }),
    folders: list({ id: 'fo_1', name: 'Folder', channelRestriction: 'ALL', restriction: null, channels: { nodes: [] }, conditions: { nodes: [] } }),
    channels: { nodes: [channel] },
    articles: list(article),
    drafts: { nodes: drafts, pageInfo: page },
    events: operation === 'ListEvents'
      ? { nodes: [{ change: { id: 'msg_1', createdAt: '2020-01-01T00:00:00Z', body: 'Hi' } }], pageInfo: page }
      : { nodes: [], pageInfo: page },
    customFields: { nodes: [], pageInfo: page },
    customProfile: '<h3>Otys</h3><style>.x { color: red }</style><ul><li>Status: <b>Active</b></li><li>Recruiter &amp; owner: Kees</li></ul>',
    rawEmail: { headers: [{ name: 'From', value: 'a@example.com' }], bodyPlainText: 'Hello' },
    rules: {
      nodes: [
        { id: 'ru_2', name: 'Second', position: 2, triggers: null, conditions: { nodes: [] }, actions: { nodes: [] } },
        { id: 'ru_1', name: 'First', position: 1, triggers: { nodes: [{ type: 'CREATED' }] }, conditions: { nodes: [{ param: 'SUBJECT', operator: 'CONTAINS', value: 'x' }] }, actions: { nodes: [{ type: 'ADD_TAG', value: 'tag_1' }] } },
      ],
      pageInfo: page,
    },
    cannedReplies: list({ id: 'cr_1', name: 'Welcome', body: 'Hi', category: { id: 'crc_1', name: 'General' } }),
    me: agent,
  };
  return { data: { [field]: data[field] ?? null } };
}

beforeAll(async () => {
  api = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body || '{}');
      requests.push({ operation: query.match(/(?:query|mutation)\s+(\w+)/)?.[1], variables });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(query, variables) ?? respond(query, variables)));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${api.address().port}/graphql`;
});

afterAll(() => new Promise(resolve => api.close(resolve)));

const ALL_ON = { allowSend: true, allowMerge: true, allowPermanentDelete: true };

async function call(name, args, options = ALL_ON, custom = () => undefined) {
  requests = [];
  drafts = [{ draftId: 'dr_1', draftType: 'REPLY', conversationId: 'cnv_1', agent, body: 'x' }];
  answer = custom;
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createGrooveServer({ token: 'test-token', apiUrl: url, ...options }).connect(serverSide);
  const client = new Client({ name: 'tools-test', version: '1.0.0' });
  await client.connect(clientSide);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  const text = result.content[0].text;
  return { isError: result.isError ?? false, text, json: JSON.parse(text), operations: requests.map(r => r.operation) };
}

// [tool, arguments, the Groove operation it ends with, a check on the result]
const normalPaths = [
  ['listConversations', {}, 'ListConversations', r => expect(r.conversations[0].id).toBe('cnv_1')],
  ['getConversation', { id: '1' }, 'GetConversation', r => expect(r.id).toBe('cnv_1')],
  ['createConversation', { channelId: 'ch_1', to: 'a@example.com', subject: 's', body: 'b' }, 'ConversationCreateEmail', r => expect(r.id).toBe('cnv_1')],
  ['logConversation', { channelId: 'ch_1', to: 'a@example.com', subject: 's', body: 'b' }, 'ConversationLog', r => expect(r).toMatchObject({ logged: true, sent: false })],
  ['updateConversation', { id: '1', subject: 'New' }, 'ConversationSubject', r => expect(r.id).toBe('cnv_1')],
  ['deleteConversation', { id: '1' }, 'ConversationDelete', r => expect(r).toBeTruthy()],
  ['deleteConversationPermanently', { id: '1' }, 'ConversationDelete', r => expect(r).toBeTruthy()],
  ['restoreConversation', { id: '1' }, 'ConversationRestore', r => expect(r).toBeTruthy()],
  ['markAsSpam', { id: '1' }, 'ConversationSpam', r => expect(r.id).toBe('cnv_1')],
  ['forwardConversation', { conversationId: '1', to: ['b@example.com'], body: 'See below' }, 'ConversationForwardV2', r => expect(r).toBeTruthy()],
  ['undoSend', { conversationId: '1', changesetId: 'cs_1' }, 'ConversationUndoSend', r => expect(r).toBeTruthy()],
  ['editNote', { messageId: 'msg_1', body: 'Changed' }, 'ConversationEditNote', r => expect(r).toBeTruthy()],
  ['reactToNote', { messageId: 'msg_1', reaction: 'thumbsup' }, 'ConversationToggleNoteReaction', r => expect(r).toBeTruthy()],
  ['deleteNote', { messageId: 'msg_1' }, 'ConversationDeleteNote', r => expect(r).toMatchObject({ deleted: true })],
  ['mergeConversations', { sourceId: '2', targetId: '3' }, 'ConversationMerge', r => expect(r).toBeTruthy()],
  ['closeConversation', { id: '1' }, 'ConversationClose', r => expect(r.id).toBe('cnv_1')],
  ['listMessages', { conversationId: '1' }, 'ListEvents', r => expect(r[0].id).toBe('msg_1')],
  ['getRawEmail', { messageId: 'msg_1' }, 'GetRawEmail', r => expect(r.headers[0]).toEqual({ name: 'From', value: 'a@example.com' })],
  ['sendMessage', { conversationId: '1', to: 'a@example.com', body: 'Hi' }, 'ConversationReply', r => expect(r).toBeTruthy()],
  ['createNote', { conversationId: '1', body: 'Note' }, 'ConversationAddNote', r => expect(r.id).toBe('cnv_1')],
  ['listDrafts', {}, 'ListDrafts', r => expect(r[0].draftId).toBe('dr_1')],
  ['listCannedReplies', { keywords: 'welcome' }, 'ListCannedReplies', r => expect(r).toMatchObject({ totalCount: 1, cannedReplies: [{ id: 'cr_1' }] })],
  ['createReplyDraft', { conversationId: '1', body: 'Draft' }, 'DraftUpsert', r => expect(r).toBeTruthy()],
  ['deleteDraft', { draftId: 'dr_1', conversationId: '1' }, 'DraftDelete', r => expect(r).toBeTruthy()],
  ['listContacts', {}, 'ListContacts', r => expect(r.contacts[0].id).toBe('co_1')],
  ['listCompanies', {}, 'ListCompanies', r => expect(r).toBeTruthy()],
  ['updateCompany', { id: 'cp_1', name: 'New name' }, 'CustomFieldValuesUpdate', r => expect(r).toBeTruthy()],
  ['mergeContacts', { source: 'co_2', target: 'co_1' }, 'ContactMerge', r => expect(r).toBeTruthy()],
  ['deleteContact', { email: 'a@example.com', confirm: true }, 'ContactDelete', r => expect(r).toMatchObject({ deleted: true })],
  ['deleteContacts', { contactIds: ['co_1'], confirm: true }, 'ContactDelete', r => expect(r).toMatchObject({ confirmed: true })],
  ['getContact', { id: 'co_1' }, 'GetContact', r => expect(r.email).toBe('a@example.com')],
  ['getContactProfile', { contactId: 'co_1' }, 'GetCustomProfile', r => expect(r.profile).toBe('Otys\n- Status: Active\n- Recruiter & owner: Kees')],
  ['createContact', { email: 'new@example.com' }, 'ContactCreate', r => expect(r.id).toBe('co_1')],
  ['updateContact', { id: 'co_1', firstName: 'B' }, 'CustomFieldValuesUpdate', r => expect(r).toBeTruthy()],
  ['listAgents', {}, 'ListAgents', r => expect(r[0].id).toBe('ag_1')],
  ['getAgent', { id: 'ag_1' }, 'ListAgents', r => expect(r.id).toBe('ag_1')],
  ['searchKbArticles', { query: 'refund' }, 'ListKbArticles', r => expect(r.articles[0].id).toBe('ka_1')],
  ['listTags', {}, 'ListTags', r => expect(r[0].id).toBe('tag_1')],
  ['listTeams', {}, 'ListTeams', r => expect(r[0].id).toBe('tm_1')],
  ['listFolders', {}, 'ListFolders', r => expect(r[0].id).toBe('fo_1')],
  ['listRules', {}, 'ListRules', r => expect(r.map(rule => rule.id)).toEqual(['ru_1', 'ru_2'])],
  ['listChannels', {}, 'ListChannels', r => expect(r[0].id).toBe('ch_1')],
  ['getChannel', { id: 'ch_1' }, 'GetChannel', r => expect(r.id).toBe('ch_1')],
];

describe('normal path', () => {
  test('covers every tool', async () => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createGrooveServer({ token: 'test-token', apiUrl: url, ...ALL_ON, allowSendAs: true, allowAttachments: true }).connect(serverSide);
    const client = new Client({ name: 'tools-test', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    await client.close();
    // getAttachment downloads a file instead of asking Groove's API; tests/attachment-reader.test.mjs covers it
    const testedElsewhere = ['getAttachment'];
    expect([...normalPaths.map(([name]) => name), ...testedElsewhere].sort()).toEqual(tools.map(tool => tool.name).sort());
  });

  test.each(normalPaths)('%s', async (name, args, operation, check) => {
    const result = await call(name, args);
    expect(result.text).not.toMatch(/"error"/);
    expect(result.isError).toBe(false);
    expect(result.operations).toContain(operation);
    check(result.json);
  });
});

describe('a missing required field is refused before Groove is asked', () => {
  test.each([
    ['getConversation', 'id is required'],
    ['createConversation', 'channelId, to, subject and body are required'],
    ['logConversation', 'channelId, to, subject and body are required'],
    ['updateConversation', 'id is required'],
    ['deleteConversation', 'id is required'],
    ['deleteConversationPermanently', 'id is required'],
    ['restoreConversation', 'id is required'],
    ['markAsSpam', 'id is required'],
    ['forwardConversation', 'conversationId, to and body are required'],
    ['undoSend', 'conversationId and changesetId are required'],
    ['editNote', 'messageId and body are required'],
    ['reactToNote', 'messageId and reaction are required'],
    ['deleteNote', 'messageId is required'],
    ['mergeConversations', 'sourceId and targetId are required'],
    ['closeConversation', 'id is required'],
    ['listMessages', 'conversationId is required'],
    ['sendMessage', 'conversationId, to and body are required'],
    ['createNote', 'conversationId and body are required'],
    ['createReplyDraft', 'conversationId and body are required'],
    ['deleteDraft', 'draftId and conversationId are required'],
    ['updateCompany', 'id is required'],
    ['mergeContacts', 'source and target are required'],
    ['deleteContact', 'email is required'],
    ['deleteContacts', 'contactIds is required'],
    ['getContact', 'id is required'],
    ['createContact', 'email is required'],
    ['updateContact', 'id is required'],
    ['getAgent', 'id is required'],
    ['searchKbArticles', 'query is required'],
    ['getChannel', 'id is required'],
  ])('%s', async (name, message) => {
    const full = normalPaths.find(([tool]) => tool === name)[1];
    const nulls = Object.fromEntries(Object.entries(full).map(([key, value]) => [key, typeof value === 'boolean' ? value : null]));
    for (const args of [{}, nulls]) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe(message);
      expect(result.operations).toEqual([]);
    }
  });
});

describe('empty text counts as missing', () => {
  test.each([
    ['getConversation', { id: '' }, 'id is required'],
    ['logConversation', { channelId: 'ch_1', to: 'a@example.com', subject: '', body: 'b' }, 'channelId, to, subject and body are required'],
    ['createNote', { conversationId: '1', body: '' }, 'conversationId and body are required'],
    ['deleteContact', { email: '', confirm: true }, 'email is required'],
  ])('%s', async (name, args, message) => {
    const result = await call(name, args);
    expect(result.json.error).toBe(message);
    expect(result.operations).toEqual([]);
  });
});

describe('a tool that is turned off never reaches Groove', () => {
  const byTool = Object.fromEntries(normalPaths.map(([name, args]) => [name, args]));
  test.each([
    ['createConversation', { allowSend: false }, 'it sends email, which needs GROOVE_ALLOW_SEND=1'],
    ['forwardConversation', { allowSend: false }, 'it sends email, which needs GROOVE_ALLOW_SEND=1'],
    ['undoSend', { allowSend: false }, 'it sends email, which needs GROOVE_ALLOW_SEND=1'],
    ['sendMessage', { allowSend: false }, 'it sends email, which needs GROOVE_ALLOW_SEND=1'],
    ['mergeConversations', { allowMerge: false }, 'merging is turned off with GROOVE_ALLOW_MERGE=0'],
    ['mergeContacts', { allowMerge: false }, 'merging is turned off with GROOVE_ALLOW_MERGE=0'],
    ['deleteConversationPermanently', { allowPermanentDelete: false }, 'it needs GROOVE_ALLOW_PERMANENT_DELETE=1'],
    ...[
      'logConversation', 'updateConversation', 'deleteConversation', 'restoreConversation', 'markAsSpam',
      'editNote', 'reactToNote', 'deleteNote', 'closeConversation', 'createNote', 'createReplyDraft',
      'deleteDraft', 'updateCompany', 'deleteContact', 'deleteContacts', 'createContact', 'updateContact',
    ].map(name => [name, { readOnly: true }, 'GROOVE_READ_ONLY is on']),
  ])('%s with %j', async (name, options, reason) => {
    const result = await call(name, byTool[name], { ...ALL_ON, ...options });
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe(`${name} is disabled: ${reason}`);
    expect(result.operations).toEqual([]);
  });
});

describe('an unknown ID is reported as not found', () => {
  const notFound = (query) => (/node\s*\(|conversation\s*\(/.test(query) ? { data: { node: null, conversation: null } } : undefined);
  test.each([
    ['getConversation', { id: 'cnv_9' }, 'Conversation not found: cnv_9'],
    ['getContact', { id: 'co_9' }, 'Contact not found: co_9'],
    ['getAgent', { id: 'ag_9' }, 'Agent not found: ag_9'],
    ['getChannel', { id: 'ch_9' }, 'Channel not found: ch_9'],
  ])('%s', async (name, args, message) => {
    const result = await call(name, args, ALL_ON, notFound);
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe(message);
  });
});

describe('read tools pass on what Groove reports', () => {
  const failing = () => ({ errors: [{ message: 'Something broke' }] });
  test.each(['listConversations', 'listContacts', 'listCompanies', 'listAgents', 'listTags', 'listTeams', 'listFolders', 'listChannels', 'listDrafts'])(
    '%s',
    async name => {
      const result = await call(name, {}, ALL_ON, failing);
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe('GraphQL Error: Something broke');
    }
  );
});

describe('an unknown tool', () => {
  test('is refused', async () => {
    const result = await call('noSuchTool', {});
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('Unknown tool: noSuchTool');
  });
});

describe('knowledge base', () => {
  async function client(custom = () => undefined) {
    requests = [];
    answer = custom;
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createGrooveServer({ token: 'test-token', apiUrl: url }).connect(serverSide);
    const c = new Client({ name: 'kb-test', version: '1.0.0' });
    await c.connect(clientSide);
    return c;
  }
  const withState = state => query =>
    /GetKbArticle/.test(query) ? { data: { node: { ...article, state, category: { title: 'Help' } } } } : undefined;

  test('search asks Groove only for what the help site shows', async () => {
    await call('searchKbArticles', { query: 'refund' });
    expect(requests[0].variables.filter).toEqual({ keywords: 'refund', state: ['PUBLISHED', 'WIP'] });
  });

  test('search returns one page with a cursor for the next', async () => {
    const pages = (query, variables) =>
      /ListKbArticles/.test(query)
        ? { data: { articles: { nodes: [{ ...article, id: variables.after ? 'ka_2' : 'ka_1' }], pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : 'c1' } } } }
        : undefined;
    const first = await call('searchKbArticles', { query: 'refund', limit: 1 }, ALL_ON, pages);
    expect(first.json).toEqual({ articles: [expect.objectContaining({ id: 'ka_1' })], pageInfo: { hasNextPage: true, endCursor: 'c1' } });
    expect(requests[0].variables.first).toBe(1);
    expect(requests[0].variables).not.toHaveProperty('after');
    const second = await call('searchKbArticles', { query: 'refund', limit: 1, after: first.json.pageInfo.endCursor }, ALL_ON, pages);
    expect(second.json).toEqual({ articles: [expect.objectContaining({ id: 'ka_2' })], pageInfo: { hasNextPage: false, endCursor: null } });
    expect(requests[0].variables).toMatchObject({ first: 1, after: 'c1' });
  });

  test('after must be text', async () => {
    const result = await call('searchKbArticles', { query: 'refund', after: 5 });
    expect(result.json.error).toBe('after must be text');
    expect(result.operations).toEqual([]);
  });

  test('the resource list asks only for what the help site shows, with details in _meta', async () => {
    const c = await client();
    const { resources } = await c.listResources();
    await c.close();
    expect(requests[0].variables.filter).toEqual({ state: ['PUBLISHED', 'WIP'] });
    expect(resources[0]).toMatchObject({ uri: 'groove://kb/article/ka_1', name: 'Article', _meta: { state: 'PUBLISHED' } });
  });

  test('a published article can be read, with details in _meta', async () => {
    const c = await client(withState('PUBLISHED'));
    const { contents } = await c.readResource({ uri: 'groove://kb/article/ka_1' });
    await c.close();
    expect(contents[0].text).toBe('# Article\n\nText');
    expect(contents[0]._meta).toMatchObject({ category: 'Help', state: 'PUBLISHED' });
  });

  test('a changed article shows its published version, not the unpublished change', async () => {
    const changed = query =>
      /GetKbArticle/.test(query)
        ? { data: { node: { ...article, state: 'WIP', title: 'New title', body: 'Unpublished', currentVersion: { title: 'Article', description: 'Live', body: 'Text' } } } }
        : undefined;
    const c = await client(changed);
    const { contents } = await c.readResource({ uri: 'groove://kb/article/ka_1' });
    await c.close();
    expect(contents[0].text).toBe('# Article\n\nText');
  });

  test('search shows the published version too', async () => {
    const changed = () => ({ data: { articles: { nodes: [{ ...article, state: 'WIP', body: 'Unpublished', currentVersion: { title: 'Article', body: 'Text' } }], pageInfo: page } } });
    const result = await call('searchKbArticles', { query: 'refund' }, ALL_ON, changed);
    expect(result.json.articles[0]).toMatchObject({ title: 'Article', body: 'Text' });
    expect(result.json.articles[0].currentVersion).toBeUndefined();
  });

  test.each(['DRAFT', 'DELETED'])('a %s article stays hidden', async state => {
    const c = await client(withState(state));
    await expect(c.readResource({ uri: 'groove://kb/article/ka_1' })).rejects.toThrow('Knowledge base article not found: ka_1');
    await c.close();
  });
});

describe('the stdio server', () => {
  test('refuses an attachment over 20 MB without dropping the connection', async () => {
    const server = spawn('node', [new URL('../dist/index.js', import.meta.url).pathname], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, GROOVE_API_TOKEN: 'test-token', GROOVE_API_URL: url, GROOVE_ALLOW_ATTACHMENTS: '1' },
    });
    const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
    let id = 1;
    const rpc = async (method, params) => {
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n');
      const { value, done } = await lines.next();
      return done ? null : JSON.parse(value);
    };
    const note = attachments => rpc('tools/call', { name: 'createNote', arguments: { conversationId: '1', body: 'x', attachments } });
    try {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } });
      const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
      const tooBig = await note([{ fileName: 'big.bin', contentBase64: big }]);
      expect(JSON.parse(tooBig.result.content[0].text).error).toBe('big.bin is larger than 20 MB');
      const after = await note([{ fileName: 'x.txt' }]);
      expect(JSON.parse(after.result.content[0].text).error).toBe('Give x.txt either a url or contentBase64');
    } finally {
      server.kill();
    }
  }, 60000);
});

describe('moving a ticket to another mailbox', () => {
  const move = (custom, extra = {}) => call('updateConversation', { id: '1', channelId: 'ch_2', ...extra }, ALL_ON, custom);
  const refusal =
    "This account has no access to mailbox ch_2, so after the move it couldn't read the ticket or move it back. " +
    'Ask the user, then pass allowNoAccess to go ahead.';
  const noAccess = query =>
    /GetChannelTicket/.test(query)
      ? { errors: [{ message: 'The selected channel is no longer available or you no longer have access. Choose another channel and try again.' }] }
      : undefined;

  test('is refused when Groove gives no access to the mailbox, and Groove is never asked to move it', async () => {
    const result = await move(noAccess);
    expect(result.json.error).toBe(refusal);
    expect(result.operations).not.toContain('ConversationChangeChannel');
  });

  test('is refused when the mailbox lists a ticket this account cannot open', async () => {
    const result = await move(query => {
      if (/GetChannelTicket/.test(query)) return { data: { conversations: { nodes: [{ id: 'cnv_9' }] } } };
      if (/GetTicketNode/.test(query)) return { errors: [{ message: 'Conversation is hidden due to permissions' }] };
      return undefined;
    });
    expect(result.json.error).toBe(refusal);
    expect(result.operations).not.toContain('ConversationChangeChannel');
  });

  test('goes ahead for an empty mailbox this account can list', async () => {
    const result = await move(query => (/GetChannelTicket/.test(query) ? { data: { conversations: { nodes: [] } } } : undefined));
    expect(result.isError).toBe(false);
    expect(result.operations).toContain('ConversationChangeChannel');
  });

  test('passes on any other error from Groove', async () => {
    const result = await move(query => (/GetChannelTicket/.test(query) ? { errors: [{ message: 'Something broke' }] } : undefined));
    expect(result.json.error).toBe('GraphQL Error: Something broke');
    expect(result.operations).not.toContain('ConversationChangeChannel');
  });

  test('allowNoAccess moves without the check, as the last step', async () => {
    const result = await move(noAccess, { allowNoAccess: true, subject: 'New', tagIds: ['tag_1'] });
    expect(result.isError).toBe(false);
    expect(result.operations).not.toContain('GetChannelTicket');
    const mutations = result.operations.filter(operation => operation.startsWith('Conversation'));
    expect(mutations).toEqual(['ConversationSubject', 'ConversationTag', 'ConversationChangeChannel']);
  });

  test('without allowNoAccess the move keeps its place among the steps', async () => {
    const result = await move(undefined, { subject: 'New', tagIds: ['tag_1'] });
    const mutations = result.operations.filter(operation => operation.startsWith('Conversation'));
    expect(mutations).toEqual(['ConversationSubject', 'ConversationChangeChannel', 'ConversationTag']);
  });

  test.each(['true', 1])('allowNoAccess %j is refused', async value => {
    const result = await move(noAccess, { allowNoAccess: value });
    expect(result.json.error).toBe('allowNoAccess must be true or false');
    expect(result.operations).toEqual([]);
  });
});

describe('team membership', () => {
  const member = { id: 'ag_1', name: 'Agent', email: 'agent@example.com' };
  const withMembers = (hasNextPage = false) => query =>
    query.includes('ListTeamsWithMembers')
      ? { data: { teams: { nodes: [{ id: 'tm_1', name: 'Team', agents: { nodes: [member], pageInfo: { hasNextPage } } }], pageInfo: page } } }
      : undefined;

  test('listTeams leaves members out by default', async () => {
    const result = await call('listTeams', {});
    expect(result.operations).toEqual(['ListTeams']);
    expect(result.json[0].members).toBeUndefined();
  });

  test('listTeams lists members with includeMembers', async () => {
    const result = await call('listTeams', { includeMembers: true }, ALL_ON, withMembers());
    expect(result.operations).toEqual(['ListTeamsWithMembers']);
    expect(result.json).toEqual([{ id: 'tm_1', name: 'Team', members: [member] }]);
  });

  test('a team with more than 100 members is an error, not a short list', async () => {
    const result = await call('listTeams', { includeMembers: true }, ALL_ON, withMembers(true));
    expect(result.isError).toBe(true);
    expect(result.json.error).toContain('more than 100 members');
  });

  test.each([['listAgents', {}], ['getAgent', { id: 'ag_1' }]])('%s lists the teams of an agent', async (tool, args) => {
    const answer = query =>
      query.includes('ListAgents')
        ? { data: { agents: { nodes: [{ ...agent, teams: { nodes: [{ id: 'tm_1', name: 'Team' }] } }], pageInfo: page } } }
        : undefined;
    const result = await call(tool, args, ALL_ON, answer);
    const found = Array.isArray(result.json) ? result.json[0] : result.json;
    expect(found.teams).toEqual([{ id: 'tm_1', name: 'Team' }]);
  });
});

describe('listConversations by date and in order', () => {
  const sent = () => requests.find(r => r.operation === 'ListConversations').variables;

  test('dates go to Groove as full date-times', async () => {
    await call('listConversations', { createdAfter: '2026-10-01', createdBefore: '2026-10-31T23:59:59Z' });
    expect(sent().filter).toEqual({ afterCreatedAt: '2026-10-01T00:00:00.000Z', beforeCreatedAt: '2026-10-31T23:59:59.000Z' });
  });

  test('a date that is not a date is refused before Groove is asked', async () => {
    const result = await call('listConversations', { createdAfter: 'last week' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toContain('createdAfter must be a date');
    expect(result.operations).toEqual([]);
  });

  test('orderBy is passed on, newest first by default', async () => {
    await call('listConversations', { state: 'closed', orderBy: { field: 'STATE_CHANGED_AT' } });
    expect(sent().orderBy).toEqual({ field: 'STATE_CHANGED_AT', direction: 'DESC' });
  });

  test('without orderBy, Groove keeps its own order', async () => {
    await call('listConversations', {});
    expect(sent().orderBy).toBeUndefined();
  });
});

describe('listConversations counts', () => {
  test('passes on the total and whether Groove capped it', async () => {
    const answer = query =>
      query.includes('ListConversations')
        ? { data: { conversations: { nodes: [ticket], pageInfo: page, totalCount: 6805, totalCountCapped: false } } }
        : undefined;
    const result = await call('listConversations', { limit: 1 }, ALL_ON, answer);
    expect(result.json).toMatchObject({ totalCount: 6805, totalCountCapped: false });
    expect(result.json.conversations).toHaveLength(1);
  });
});

describe('listMessages from the start and in plain text', () => {
  const message = n => ({ id: `msg_${n}`, createdAt: `2020-01-0${n}T00:00:00Z`, body: `<p>Text ${n}</p>`, bodyPlainText: `Text ${n}` });
  const three = (query, variables) =>
    query.includes('ListEvents') && variables.filter.eventType?.includes('MESSAGE_CREATED')
      ? { data: { events: { nodes: [3, 1, 2].map(n => ({ change: message(n) })), pageInfo: page } } }
      : undefined;
  const ids = result => result.json.map(m => m.id);

  test('limit counts from the end by default', async () => {
    expect(ids(await call('listMessages', { conversationId: '1', limit: 2 }, ALL_ON, three))).toEqual(['msg_2', 'msg_3']);
  });

  test('from start gives the first messages', async () => {
    expect(ids(await call('listMessages', { conversationId: '1', limit: 2, from: 'start' }, ALL_ON, three))).toEqual(['msg_1', 'msg_2']);
  });

  test('plain leaves out the HTML body', async () => {
    const result = await call('listMessages', { conversationId: '1', format: 'plain' }, ALL_ON, three);
    expect(result.json[0]).toEqual({ id: 'msg_1', createdAt: '2020-01-01T00:00:00Z', bodyPlainText: 'Text 1' });
  });

  test('full keeps both', async () => {
    const result = await call('listMessages', { conversationId: '1' }, ALL_ON, three);
    expect(result.json[0]).toMatchObject({ body: '<p>Text 1</p>', bodyPlainText: 'Text 1' });
  });

  test.each([['from', 'middle', 'from must be start or end'], ['format', 'html', 'format must be full or plain']])(
    'an unknown %s is refused',
    async (key, value, error) => {
      const result = await call('listMessages', { conversationId: '1', [key]: value }, ALL_ON, three);
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe(error);
    },
  );
});

describe('listConversations with every filter', () => {
  const sent = () => requests.find(r => r.operation === 'ListConversations').variables.filter;

  test('each filter goes to Groove under its own name', async () => {
    await call('listConversations', {
      states: ['opened', 'snoozed'],
      contactEmail: 'a@example.com',
      tagNames: ['urgent'],
      mentionedAgentId: 'ag_1',
      draftAuthorId: 'ag_2',
      draftType: 'reply_all',
      rating: 'bad',
      starred: false,
      type: ['email', 'widget'],
      updatedAfter: '2026-10-01',
      updatedBefore: '2026-10-31T23:59:59Z',
    });
    expect(sent()).toEqual({
      states: ['OPENED', 'SNOOZED'],
      contactEmail: 'a@example.com',
      tagNames: ['urgent'],
      mentionedAgent: 'ag_1',
      draftAuthor: 'ag_2',
      draftType: 'REPLY_ALL',
      rating: 'BAD',
      starred: false,
      type: ['EMAIL', 'WIDGET'],
      afterUpdatedAt: '2026-10-01T00:00:00.000Z',
      beforeUpdatedAt: '2026-10-31T23:59:59.000Z',
    });
  });

  test('state spam is passed on', async () => {
    await call('listConversations', { state: 'spam' });
    expect(sent()).toEqual({ state: 'SPAM' });
  });

  test('the trash is a filter of its own', async () => {
    await call('listConversations', { deleted: true });
    expect(sent()).toEqual({ deleted: true });
  });

  test('an update date that is not a date is refused before Groove is asked', async () => {
    const result = await call('listConversations', { updatedBefore: 'yesterday' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toContain('updatedBefore must be a date');
    expect(result.operations).toEqual([]);
  });

  test('starred must be true or false', async () => {
    const result = await call('listConversations', { starred: 'yes' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('starred must be true or false');
  });
});

describe('saved replies', () => {
  test('keywords and categories go to Groove as a filter', async () => {
    await call('listCannedReplies', { keywords: 'vakantie', categoryIds: ['crc_1'], limit: 5 });
    const sent = requests.find(r => r.operation === 'ListCannedReplies').variables;
    expect(sent).toMatchObject({ first: 5, filter: { keywords: 'vakantie', categoryIds: ['crc_1'] } });
  });
});

describe('rules', () => {
  test('come back in run order, with their parts as plain lists', async () => {
    const result = await call('listRules', {});
    expect(result.json[0]).toMatchObject({
      id: 'ru_1',
      triggers: [{ type: 'CREATED' }],
      conditions: [{ param: 'SUBJECT', operator: 'CONTAINS', value: 'x' }],
      actions: [{ type: 'ADD_TAG', value: 'tag_1' }],
    });
    expect(result.json[1]).toMatchObject({ id: 'ru_2', triggers: [], conditions: [], actions: [] });
  });

  test('state goes to Groove in capitals, and anything else is refused', async () => {
    await call('listRules', { state: 'inactive' });
    expect(requests.find(r => r.operation === 'ListRules').variables.filter).toEqual({ state: 'INACTIVE' });
    const result = await call('listRules', { state: 'paused' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('state must be active or inactive');
  });
});

describe('original email', () => {
  test('a message without one says so', async () => {
    const result = await call('getRawEmail', { messageId: 'msg_9' }, ALL_ON, query => (query.includes('GetRawEmail') ? { data: { rawEmail: null } } : undefined));
    expect(result.isError).toBe(true);
    expect(result.json.error).toContain('No original email for message msg_9');
  });

  test('a very long body is cut at 100,000 characters', async () => {
    const answer = query => (query.includes('GetRawEmail') ? { data: { rawEmail: { headers: [], bodyPlainText: 'x'.repeat(150000) } } } : undefined);
    const result = await call('getRawEmail', { messageId: 'msg_1' }, ALL_ON, answer);
    expect(result.json.bodyPlainText).toContain('[truncated at 100000 chars]');
    expect(result.json.bodyPlainText.length).toBeLessThan(100100);
  });
});

describe('contact profile', () => {
  test('an empty profile says so', async () => {
    const result = await call('getContactProfile', { contactId: 'co_1' }, ALL_ON, query => (query.includes('GetCustomProfile') ? { data: { customProfile: '<div class="x">\n\n</div>' } } : undefined));
    expect(result.json.profile).toBe('This contact has no custom profile, or it is empty');
  });

  test('refresh and mailbox go to Groove', async () => {
    await call('getContactProfile', { contactId: 'co_1', channelId: 'ch_1', refresh: true });
    expect(requests.find(r => r.operation === 'GetCustomProfile').variables).toEqual({ contactId: 'co_1', channelId: 'ch_1', hardRefresh: true });
  });
});
