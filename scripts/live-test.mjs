#!/usr/bin/env node
// Runs the built server against a real Groove account and checks every tool.
// Output holds only counts and ticket numbers, never message text.
//
//   GROOVE_API_TOKEN=... npm run test:live            changes nothing
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 \
//     npm run test:live -- --write                    sends 2 test mails
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TICKET=12345 \
//     npm run test:live -- --drafts                   saves and deletes drafts, sends nothing
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 \
//     npm run test:live -- --merge                    sends 3 test mails, merges those tickets
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TO=you@example.com npm run test:live -- --contacts
//                                                     only this: creates and deletes contacts, sends nothing
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 \
//     npm run test:live -- --tickets                  only this: sends 8 test mails, changes and deletes test tickets
//
//   GROOVE_API_TOKEN=... npm run test:live -- --update
//                                                     changes a [TEST] ticket and puts it back

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const write = process.argv.includes('--write');
const drafts = process.argv.includes('--drafts');
const update = process.argv.includes('--update');
const merge = process.argv.includes('--merge');
const contactsOnly = process.argv.includes('--contacts');
const ticketsOnly = process.argv.includes('--tickets');
const sends = write || merge || ticketsOnly;
const { GROOVE_API_TOKEN, GROOVE_TEST_TO, GROOVE_TEST_CHANNEL, GROOVE_TEST_TICKET } = process.env;

if (!GROOVE_API_TOKEN) {
  console.error('Set GROOVE_API_TOKEN first.');
  process.exit(1);
}

if (sends && (!GROOVE_TEST_TO || !GROOVE_TEST_CHANNEL)) {
  console.error('--write, --merge and --tickets need GROOVE_TEST_TO and GROOVE_TEST_CHANNEL.');
  process.exit(1);
}

if (drafts && !GROOVE_TEST_TICKET) {
  console.error('--drafts needs GROOVE_TEST_TICKET.');
  process.exit(1);
}

if (contactsOnly && !GROOVE_TEST_TO) {
  console.error('--contacts needs GROOVE_TEST_TO, an address that has tickets.');
  process.exit(1);
}

const server = spawn('node', [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { ...process.env, GROOVE_ALLOW_SEND: sends ? '1' : '0', GROOVE_ALLOW_SEND_AS: ticketsOnly ? '1' : '0', GROOVE_ALLOW_PERMANENT_DELETE: ticketsOnly ? '1' : '0', GROOVE_ALLOW_ATTACHMENTS: ticketsOnly ? '1' : '0', GROOVE_READ_ONLY: '0' },
});
const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
let nextId = 1;

async function rpc(method, params = {}) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const { value } = await lines.next();
  return JSON.parse(value);
}

async function call(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args });
  const value = JSON.parse(reply.result.content[0].text);
  if (value?.error) throw new Error(value.error);
  return value;
}

async function fails(name, args) {
  try {
    await call(name, args);
    return null;
  } catch (error) {
    return error.message;
  }
}

let passed = 0;
let failed = 0;

async function test(title, check) {
  try {
    const note = await check();
    console.log(`  ok    ${title}${note ? ` (${note})` : ''}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${title}: ${error.message}`);
    failed++;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function ids(rows) {
  return rows.map(row => row.id);
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'live-test', version: '1' },
});
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

if (ticketsOnly) {
  console.log('\nTickets');
  const { createInterface: prompt } = await import('node:readline/promises');
  const input = prompt({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`\nSend 8 test mails to plus addresses of ${GROOVE_TEST_TO}? Type yes: `);
  input.close();
  if (answer !== 'yes') {
    console.log('Skipped the ticket tests.');
    server.kill();
    process.exit(0);
  }

  const [local, domain] = GROOVE_TEST_TO.split('@');
  const stamp = Date.now();
  const log = async name =>
    (await call('logConversation', {
      channelId: GROOVE_TEST_CHANNEL,
      to: GROOVE_TEST_TO,
      subject: `[TEST] groovehq-mcp ticket test ${name}`,
      body: 'Automated groovehq-mcp ticket test.',
      skipNotifications: true,
    })).ticket;
  const ticket = await log('A');
  const id = String(ticket.number);
  const read = () => call('getConversation', { id });
  console.log(`  using ticket ${id}`);

  await test('updateConversation changes the subject and stars', async () => {
    const renamed = await call('updateConversation', { id, subject: `[TEST] renamed ${stamp}`, starred: true });
    expect(renamed.subject === `[TEST] renamed ${stamp}` && renamed.starred, 'not changed');
    expect(!(await call('updateConversation', { id, starred: false })).starred, 'still starred');
  });

  await test('updateConversation marks a ticket unread', async () => {
    expect((await call('updateConversation', { id, state: 'unread' })).state === 'UNREAD', 'wrong state');
  });

  await test('updateConversation changes the contact and keeps the mail', async () => {
    const other = await call('createContact', { email: `${local}+other${stamp}@${domain}`, firstName: 'Test' });
    const moved = await call('updateConversation', { id, contactId: other.id });
    expect(moved.contact.id === other.id, 'not moved');
    const back = await call('updateConversation', { id, contactId: ticket.contact.id });
    expect(back.contact.id === ticket.contact.id, 'not moved back');
    // Groove's email lookup and ticket count take a moment to catch up with the move
    let removed = false;
    for (let tries = 0; tries < 10 && !removed; tries++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      removed = (await call('deleteContact', { email: other.email, confirm: true }).catch(() => ({}))).deleted === true;
    }
    expect(removed, 'test contact not deleted');
  });

  await test('spam, delete and restore change the state', async () => {
    expect((await call('markAsSpam', { confirm: true, id })).state === 'SPAM', 'not spam');
    expect((await call('restoreConversation', { id })).state === 'OPENED', 'not restored');
    await call('deleteConversation', { confirm: true, id });
    expect((await read()).state !== 'OPENED', 'not deleted');
    expect((await call('restoreConversation', { id })).state === 'OPENED', 'not restored');
  });

  await test('editNote and deleteNote change a note', async () => {
    await call('createNote', { conversationId: id, body: `Note ${stamp}` });
    const note = (await call('listMessages', { conversationId: id })).find(row => row.bodyPlainText?.includes(`Note ${stamp}`));
    await call('editNote', { messageId: note.id, body: `Edited ${stamp}` });
    expect((await call('reactToNote', { messageId: note.id, reaction: '👍' })).toggled, 'no reaction');
    const edited = (await call('listMessages', { conversationId: id })).find(row => row.id === note.id);
    expect(edited.bodyPlainText.includes(`Edited ${stamp}`), 'not edited');
    expect((await call('deleteNote', { confirm: true, messageId: note.id })).deleted, 'not deleted');
  });

  await test('a mail can be undone right after sending', async () => {
    const reply = await call('sendMessage', { conversationId: id, to: `${local}+undo@${domain}`, body: 'Automated undo test.' });
    expect(reply.changesetId, 'no changesetId');
    expect((await call('undoSend', { conversationId: id, changesetId: reply.changesetId })).undone, 'not undone');
    await new Promise(resolve => setTimeout(resolve, 3000));
    // Groove empties an undone mail instead of removing it, so the count stays the same
    const messages = await call('listMessages', { conversationId: id });
    expect(!messages.some(row => row.bodyPlainText?.includes('Automated undo test')), 'mail stayed on the ticket');
  });

  await test('forwardConversation keeps the ticket as it was', async () => {
    const before = await read();
    const forwarded = await call('forwardConversation', { conversationId: id, to: [`${local}+fwd@${domain}`], body: 'Automated forward test.' });
    expect(forwarded.subject === before.subject && forwarded.state === before.state, 'ticket changed');
  });

  await test('deleteConversation can be restored unless permanent', async () => {
    const other = await log('B');
    const otherId = String(other.number);
    expect((await call('deleteConversation', { confirm: true, id: otherId })).deleted, 'not deleted');
    expect((await call('restoreConversation', { id: otherId })).state === 'OPENED', 'not restored');
    expect((await call('deleteConversationPermanently', { confirm: true, id: otherId })).permanent, 'not permanent');
    expect(await fails('getConversation', { id: otherId }), 'still there');
  });

  const fileText = `Attachment test ${stamp}`;
  const file = { fileName: `test-${stamp}.txt`, contentType: 'text/plain', contentBase64: Buffer.from(fileText).toString('base64') };
  const attached = async ticketId =>
    (await call('listMessages', { conversationId: ticketId })).flatMap(row => row.attachments?.nodes ?? []);

  await test('createNote attaches a base64 file', async () => {
    await call('createNote', { conversationId: id, body: 'Base64 attachment.', attachments: [file] });
    const [stored] = await attached(id);
    expect(stored?.fileName === file.fileName, 'file missing');
    const copy = await fetch(stored.url);
    expect((await copy.text()) === fileText, 'wrong content');
  });

  await test('createNote attaches a file from a url', async () => {
    const [stored] = await attached(id);
    await call('createNote', { conversationId: id, body: 'URL attachment.', attachments: [{ fileName: `url-${stamp}.txt`, url: stored.url }] });
    expect((await attached(id)).some(row => row.fileName === `url-${stamp}.txt`), 'file missing');
  });

  await test('bad attachments are refused before anything is sent', async () => {
    const urls = [
      'http://example.com/file.txt',
      'https://localhost/file.txt',
      'https://127.0.0.1/file.txt',
      'https://10.0.0.1/file.txt',
      'https://192.168.1.1/file.txt',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/file.txt',
      'https://server.internal/file.txt',
    ];
    const notes = (await read()).counts.notes;
    for (const url of urls) {
      expect(await fails('createNote', { conversationId: id, body: 'x', attachments: [{ fileName: 'x.txt', url }] }), `allowed ${url}`);
    }
    expect(await fails('createNote', { conversationId: id, body: 'x', attachments: [{ fileName: 'x.txt' }] }), 'no content allowed');
    expect(await fails('createNote', { conversationId: id, body: 'x', attachments: [{ ...file, url: 'https://example.com/x' }] }), 'both allowed');
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
    expect(await fails('createNote', { conversationId: id, body: 'x', attachments: [{ fileName: 'big.bin', contentBase64: tooBig }] }), 'too big allowed');
    expect((await read()).counts.notes === notes, 'a note was added');
  });

  await test('logConversation attaches a file', async () => {
    const result = await call('logConversation', {
      channelId: GROOVE_TEST_CHANNEL,
      to: GROOVE_TEST_TO,
      subject: '[TEST] groovehq-mcp log attachment',
      body: 'Log attachment.',
      state: 'closed',
      skipNotifications: true,
      attachments: [file],
    });
    expect(result.ticket.counts.attachments === 1, 'file missing');
  });

  await test('sendMessage sends a file', async () => {
    await call('sendMessage', { conversationId: id, to: `${local}+file@${domain}`, body: 'Automated attachment test.', attachments: [file] });
    expect((await attached(id)).filter(row => row.fileName === file.fileName).length >= 2, 'file missing');
  });

  await test('forwardConversation sends a file', async () => {
    const forwarded = await call('forwardConversation', { conversationId: id, to: [`${local}+fwdfile@${domain}`], body: 'Automated forward with a file.', attachments: [file] });
    expect(forwarded.counts.attachments >= 1, 'file missing');
  });

  await test('createConversation sends a file', async () => {
    const created = await call('createConversation', { channelId: GROOVE_TEST_CHANNEL,
      to: `${local}+newfile@${domain}`,
      subject: '[TEST] groovehq-mcp new ticket with a file',
      body: 'Automated new ticket with a file.',
      attachments: [file],
    });
    expect(created.counts.attachments === 1, 'file missing');
    await call('closeConversation', { id: String(created.number) });
  });

  const whoAmI = await fetch(process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROOVE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ me { id } }' }),
  });
  const me = (await whoAmI.json()).data.me.id;
  const agents = await call('listAgents');
  const others = agents.filter(agent => agent.state === 'ACTIVE' && agent.id !== me);
  const author = others[Math.floor(Math.random() * others.length)];
  const send = (name, args = {}) =>
    call('createConversation', { channelId: GROOVE_TEST_CHANNEL,
      to: `${local}+${name}${stamp}@${domain}`,
      subject: `[TEST] groovehq-mcp ${name}`,
      body: 'Automated groovehq-mcp test. Feel free to ignore.',
      ...args,
    });
  const firstAuthor = async number =>
    (await call('listMessages', { conversationId: String(number) }))[0]?.author?.id;

  await test('createConversation sends as a random agent and closes the ticket', async () => {
    const created = await send('author', { authorId: author.id, state: 'closed' });
    expect(created.state === 'CLOSED', `state is ${created.state}`);
    expect((await firstAuthor(created.number)) === author.id, 'wrong author');
    return `ticket ${created.number} as ${author.id}`;
  });

  await test('sendMessage, createNote and logConversation act as a random agent', async () => {
    const lastAuthor = async number =>
      (await call('listMessages', { conversationId: String(number) })).at(-1)?.author?.id;
    await call('sendMessage', { conversationId: id, to: `${local}+reply${stamp}@${domain}`, body: 'Automated send as test.', authorId: author.id });
    expect((await lastAuthor(id)) === author.id, 'wrong reply author');
    await call('createNote', { conversationId: id, body: 'Automated send as note.', authorId: author.id });
    expect((await lastAuthor(id)) === author.id, 'wrong note author');
    const logged = await call('logConversation', { channelId: GROOVE_TEST_CHANNEL, to: `${local}+logas${stamp}@${domain}`, subject: '[TEST] groovehq-mcp logged as agent', body: 'Automated send as log.', state: 'closed', authorId: author.id });
    expect((await lastAuthor(logged.ticket.number)) === author.id, 'wrong log author');
    return `tickets ${id} and ${logged.ticket.number} as ${author.id}`;
  });

  await test('authorId is hidden and refused without GROOVE_ALLOW_SEND_AS', async () => {
    const { createGrooveServer } = await import('../dist/server.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createGrooveServer({ token: GROOVE_API_TOKEN, apiUrl: process.env.GROOVE_API_URL, allowSend: true }).connect(serverSide);
    const client = new Client({ name: 'live-test', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const calls = {
      createConversation: { channelId: GROOVE_TEST_CHANNEL, to: `${local}+sendas${stamp}@${domain}`, subject: 'x', body: 'x' },
      sendMessage: { conversationId: id, to: `${local}+sendas${stamp}@${domain}`, body: 'x' },
      createNote: { conversationId: id, body: 'x' },
      logConversation: { channelId: GROOVE_TEST_CHANNEL, to: `${local}+sendas${stamp}@${domain}`, subject: 'x', body: 'x' },
    };
    for (const [name, args] of Object.entries(calls)) {
      expect(!tools.find(tool => tool.name === name).inputSchema.properties.authorId, `${name} lists authorId`);
      const reply = await client.callTool({ name, arguments: { ...args, authorId: author.id } });
      expect(reply.content[0].text.includes('GROOVE_ALLOW_SEND_AS'), `${name} accepted authorId`);
    }
    await client.close();
  });

  await test('createConversation defaults to the token owner and an open ticket', async () => {
    const created = await send('default');
    expect(created.state === 'OPENED', `state is ${created.state}`);
    expect((await firstAuthor(created.number)) === me, 'wrong author');
    await call('closeConversation', { id: String(created.number) });
    return `ticket ${created.number}`;
  });

  await test('createConversation snoozes the ticket', async () => {
    const until = new Date(Date.now() + 86400000).toISOString();
    const created = await send('snooze', { state: 'snoozed', snoozedUntil: until });
    expect(created.state === 'SNOOZED', `state is ${created.state}`);
    expect(created.snoozed?.until, 'no snooze date');
    await call('closeConversation', { id: String(created.number) });
    return `ticket ${created.number}`;
  });

  await test('createConversation refuses a made-up agent and a stray snooze date', async () => {
    let madeUp;
    do madeUp = `ag_${Math.floor(Math.random() * 1e10)}`;
    while (agents.some(agent => agent.id === madeUp));
    // Groove itself would send this one as the token owner
    const refused = await fails('createConversation', { channelId: GROOVE_TEST_CHANNEL, to: `${local}+badauthor${stamp}@${domain}`, subject: 'x', body: 'x', authorId: madeUp });
    expect(refused?.includes('Unknown agent'), 'made-up agent accepted');
    const reply = await fails('sendMessage', { conversationId: id, to: `${local}+badreply${stamp}@${domain}`, body: 'x', authorId: madeUp });
    expect(reply?.includes('Unknown agent'), 'made-up agent replied');
    const note = await fails('createNote', { conversationId: id, body: 'x', authorId: madeUp });
    expect(note?.includes('Unknown agent'), 'made-up agent wrote a note');
    const logged = await fails('logConversation', { channelId: GROOVE_TEST_CHANNEL, to: `${local}+badlog${stamp}@${domain}`, subject: 'x', body: 'x', authorId: madeUp });
    expect(logged?.includes('Unknown agent'), 'made-up agent logged a ticket');
    const stray = await fails('createConversation', { channelId: GROOVE_TEST_CHANNEL, to: `${local}+badsnooze${stamp}@${domain}`, subject: 'x', body: 'x', snoozedUntil: new Date().toISOString() });
    expect(stray?.includes('needs state snoozed'), 'snooze date accepted');
  });

  await test('closeConversation closes the test ticket', async () => {
    expect((await call('closeConversation', { id })).state === 'CLOSED', 'not closed');
  });

  server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (contactsOnly) {
  console.log('\nContacts');
  const [name, domain] = GROOVE_TEST_TO.split('@');
  const stamp = Date.now();
  const address = letter => `${name}+${letter}${stamp}@${domain}`;
  const exists = async email => (await call('listContacts', { email })).contacts.length === 1;

  // Groove's email lookup takes a moment to catch up with a change
  const settles = async (email, wanted) => {
    for (let tries = 0; tries < 10; tries++) {
      if ((await exists(email)) === wanted) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
  };
  const create = async letter => {
    const contact = await call('createContact', { email: address(letter), firstName: 'Test', lastName: letter.toUpperCase() });
    expect(await settles(contact.email, true), 'new contact not found');
    return contact;
  };
  const owner = (await call('listContacts', { email: GROOVE_TEST_TO })).contacts[0];

  await test('listContacts finds an exact address and ignores capitals', async () => {
    expect(owner?.email === GROOVE_TEST_TO, 'not found');
    expect(owner.conversationCount > 0, 'GROOVE_TEST_TO needs tickets');
    expect((await call('listContacts', { email: GROOVE_TEST_TO.toUpperCase() })).contacts.length === 1, 'capitals matter');
    expect(!(await call('listContacts', { email: name })).contacts.length, 'matched part of an address');
  });

  await test('orphansOnly reads at most 500 contacts and returns only zeros', async () => {
    const result = await call('listContacts', { orphansOnly: true, limit: 10 });
    expect(result.contactsRead <= 500, 'read too many');
    expect(result.contacts.length && result.contacts.every(row => row.conversationCount === 0), 'wrong contacts');
    return `read ${result.contactsRead}, found ${result.contacts.length}`;
  });

  await test('deleteContact only shows what it would do without confirm', async () => {
    const contact = await create('a');
    const result = await call('deleteContact', { email: contact.email });
    expect(result.deleted === false && result.wouldDelete.id === contact.id, 'wrong result');
    expect(await exists(contact.email), 'deleted without confirm');
    expect((await call('deleteContact', { email: contact.email, confirm: true })).deleted, 'not deleted');
    expect(await settles(contact.email, false), 'still there');
  });

  await test('deleteContact finds nothing for an unknown address', async () => {
    expect((await call('deleteContact', { email: address('nobody'), confirm: true })).found === false, 'wrong result');
  });

  await test('a contact with tickets cannot be deleted', async () => {
    const message = await fails('deleteContact', { email: GROOVE_TEST_TO, confirm: true });
    expect(message?.includes('mergeContacts'), 'not refused');
    expect(await exists(GROOVE_TEST_TO), 'deleted');
  });

  await test('mergeContacts removes the source and keeps the target', async () => {
    const source = await create('c');
    const target = await create('d');
    expect(await fails('mergeContacts', { confirm: true, source: source.email, target: source.id }), 'merged into itself');
    const result = await call('mergeContacts', { confirm: true, source: source.email, target: target.id });
    expect(result.merged && result.contact.id === target.id, 'wrong result');
    expect((await settles(source.email, false)) && (await exists(target.email)), 'wrong contact left');
    await call('deleteContact', { email: target.email, confirm: true });
  });

  await test('updateContact removes and adds a company', async () => {
    const contact = await create('e');
    try {
      const company = owner.companies?.nodes[0];
      expect(company, 'GROOVE_TEST_TO has no company');
      const has = row => row.companies?.nodes.some(item => item.id === company.id);
      expect(!has(await call('updateContact', { id: contact.id, removeCompanyIds: [company.id] })), 'not removed');
      expect(has(await call('updateContact', { id: contact.id, companyIds: [company.id] })), 'not added');
      expect(await fails('updateContact', { id: contact.id, companyIds: [company.id], removeCompanyIds: [company.id] }), 'conflict allowed');
    } finally {
      await call('deleteContact', { email: contact.email, confirm: true });
    }
  });

  await test('updateContact adds and removes secondary emails', async () => {
    const contact = await create('f');
    const [one, two] = [address('g'), address('h')];
    try {
      await call('updateContact', { id: contact.id, addSecondaryEmails: [one, two] });
      let row = await call('getContact', { id: contact.id });
      expect(row.secondaryEmails.length === 2 && row.email === contact.email, 'not added');
      expect(await fails('updateContact', { id: contact.id, addSecondaryEmails: [`${one},${two}`] }), 'bad address accepted');
      expect(await fails('updateContact', { id: contact.id, removeSecondaryEmails: [address('nobody')] }), 'unknown address accepted');
      row = await call('updateContact', { id: contact.id, removeSecondaryEmails: [one] });
      expect(row.secondaryEmails.length === 1 && row.secondaryEmails[0] === two, `wrong list: ${row.secondaryEmails}`);
      expect(row.email === contact.email, 'main address changed');
      const lookup = await call('deleteContact', { email: two });
      expect(lookup.found === false, 'matched a secondary address');
    } finally {
      await call('deleteContact', { email: contact.email, confirm: true });
    }
  });

  await test('updateCompany changes the name and extra domains', async () => {
    const graphql = async (query, input) => {
      const response = await fetch(process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROOVE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { input } }),
      });
      return (await response.json()).data;
    };
    const { companyCreate } = await graphql(
      'mutation($input: CompanyCreateInput!) { companyCreate(input: $input) { company { id } } }',
      { customFields: [{ customFieldIdOrKey: 'company_name', value: `[TEST] groovehq-mcp ${stamp}` }] }
    );
    const id = companyCreate.company.id;
    try {
      const renamed = await call('updateCompany', { id, name: `[TEST] renamed ${stamp}` });
      expect(renamed.name === `[TEST] renamed ${stamp}`, 'not renamed');
      const [one, two] = [`one${stamp}.example`, `two${stamp}.example`];
      const added = await call('updateCompany', { id, addDomains: [one, two] });
      expect(added.domains.length === 2, 'domains not added');
      expect(await fails('updateCompany', { id, addDomains: ['not a domain'] }), 'bad domain accepted');
      const left = await call('updateCompany', { id, removeDomains: [one] });
      expect(left.domains.length === 1 && left.domains[0] === two, `wrong list: ${left.domains}`);
    } finally {
      await graphql('mutation($input: CompanyDeleteInput!) { companyDelete(input: $input) { errors { message } } }', { companyId: id });
    }
  });

  await test('listCompanies pages without overlap', async () => {
    const first = await call('listCompanies', { limit: 5 });
    const second = await call('listCompanies', { limit: 5, after: first.pageInfo.endCursor });
    expect(first.companies.length === 5, 'wrong page size');
    expect(!ids(second.companies).some(id => ids(first.companies).includes(id)), 'pages overlap');
  });

  await test('listCompanies sorts by ticket count', async () => {
    const { companies } = await call('listCompanies', { limit: 20, orderBy: { field: 'CONVERSATION_COUNT', direction: 'DESC' } });
    // Groove's sort on counts is only rough, so this compares the two ends
    const counts = companies.map(row => row.conversationCount);
    expect(counts[0] > counts[counts.length - 1], `not sorted: ${counts}`);
  });

  server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { conversations: closed } = await call('listConversations', { state: 'closed', limit: 50 });
const ticket = closed[0];

console.log('\nReading');

await test('listConversations pages without overlap', async () => {
  const first = await call('listConversations', { limit: 5 });
  const second = await call('listConversations', { limit: 5, after: first.pageInfo.endCursor });
  expect(first.pageInfo.hasNextPage, 'expected a next page');
  expect(!ids(second.conversations).some(id => ids(first.conversations).includes(id)), 'pages overlap');
});

await test('listConversations filters by state', async () => {
  expect(closed.every(row => row.state === 'CLOSED'), 'found a ticket that is not closed');
});

await test('listConversations filters by channel', async () => {
  const channelId = ticket.channel.id;
  const { conversations } = await call('listConversations', { channelId, limit: 10 });
  expect(conversations.every(row => row.channel.id === channelId), 'wrong channel');
});

await test('listConversations searches by keyword', async () => {
  const { conversations } = await call('listConversations', { keywords: 'the', limit: 5 });
  return `${conversations.length} found`;
});

await test('getConversation works by number and by ID', async () => {
  for (const id of [`${ticket.number}`, `#${ticket.number}`, ticket.id]) {
    expect((await call('getConversation', { id })).id === ticket.id, `wrong ticket for ${id}`);
  }
});

await test('listMessages returns every message', async () => {
  const sample = closed.slice(0, 15);
  for (const row of sample) {
    const messages = await call('listMessages', { conversationId: `${row.number}` });
    const expected = row.counts.messages + row.counts.notes;
    expect(messages.length === expected, `ticket ${row.number}: ${messages.length} of ${expected}`);
  }
  return `${sample.length} tickets`;
});

await test('listMessages keeps the newest with a limit', async () => {
  const row = closed.reduce((a, b) => (b.counts.messages > a.counts.messages ? b : a));
  const all = await call('listMessages', { conversationId: `${row.number}` });
  const last = await call('listMessages', { conversationId: `${row.number}`, limit: 2 });
  expect(ids(last).join() === ids(all.slice(-2)).join(), 'limit did not keep the newest');
});

await test('listContacts pages without overlap', async () => {
  const first = await call('listContacts', { limit: 5 });
  const second = await call('listContacts', { limit: 5, after: first.pageInfo.endCursor });
  expect(!ids(second.contacts).some(id => ids(first.contacts).includes(id)), 'pages overlap');
});

await test('getContact', async () => {
  const contact = await call('getContact', { id: ticket.contact.id });
  expect(contact.id === ticket.contact.id, 'wrong contact');
});

await test('listAgents and getAgent', async () => {
  const agents = await call('listAgents');
  expect(agents.length > 0, 'no agents');
  expect((await call('getAgent', { id: agents[0].id })).id === agents[0].id, 'wrong agent');
  return `${agents.length} agents`;
});

await test('listChannels and getChannel', async () => {
  const channels = await call('listChannels');
  expect((await call('getChannel', { id: channels[0].id })).id === channels[0].id, 'wrong channel');
  return `${channels.length} channels`;
});

const tags = await call('listTags');
const teams = await call('listTeams');

await test('listTags returns tags that filter tickets', async () => {
  expect(new Set(ids(tags)).size === tags.length, 'duplicate tags');
  const { conversations } = await call('listConversations', { tagIds: [tags[0].id], limit: 10 });
  expect(conversations.every(row => ids(row.tags.nodes).includes(tags[0].id)), 'wrong tag');
  return `${tags.length} tags`;
});

await test('listTags searches by name', async () => {
  const found = await call('listTags', { search: tags[0].name });
  expect(ids(found).includes(tags[0].id), 'tag not found');
});

await test('listTeams returns teams that filter tickets', async () => {
  expect(teams.length > 0, 'no teams');
  const { conversations } = await call('listConversations', { assignedTeamId: teams[0].id, limit: 10 });
  expect(conversations.every(row => row.assigned?.team?.id === teams[0].id), 'wrong team');
  return `${teams.length} teams`;
});

const folders = await call('listFolders');

await test('listFolders returns folders that filter tickets', async () => {
  expect(folders.length > 0, 'no folders');
  expect(new Set(ids(folders)).size === folders.length, 'duplicate folders');
  expect(folders.every(folder => folder.name && /[^\s\p{P}]/u.test(folder.name)), 'divider in the list');
  expect(folders.every(folder => folder.channels === 'all' || folder.channels.length > 0), 'folder without mailboxes');
  expect(folders.every(folder => !folder.assignedTeam || ids(teams).includes(folder.assignedTeam.id)), 'unknown team');
  await call('listConversations', { folderId: folders[0].id, limit: 1 });
  return `${folders.length} folders`;
});

await test('folderId works with state and keywords', async () => {
  const folder = folders.find(row => row.channels === 'all') ?? folders[0];
  for (const filters of [{ state: 'opened' }, { keywords: 'test' }]) {
    await call('listConversations', { folderId: folder.id, limit: 1, ...filters });
  }
});

await test('folderId works with one of its mailboxes', async () => {
  const folder = folders.find(row => row.channels !== 'all');
  if (!folder) return 'no folder limited to a mailbox';
  const { conversations } = await call('listConversations', { folderId: folder.id, channelId: folder.channels[0].id, limit: 5 });
  expect(conversations.every(row => row.channel.id === folder.channels[0].id), 'wrong mailbox');
});

await test('unknown folders give a clear error', async () => {
  const error = await fails('listConversations', { folderId: 'fol_0000000000' });
  expect(error === 'Folder not found: fol_0000000000', 'wrong error');
});

await test('searchKbArticles returns live articles a page at a time', async () => {
  const first = await call('searchKbArticles', { query: 'a', limit: 1 });
  expect(Array.isArray(first.articles) && first.pageInfo, 'no articles and pageInfo');
  expect(first.articles.every(article => ['PUBLISHED', 'WIP'].includes(article.state)), 'shows an article that is not live');
  if (first.pageInfo.hasNextPage) {
    const next = await call('searchKbArticles', { query: 'a', limit: 1, after: first.pageInfo.endCursor });
    expect(!next.articles.some(article => ids(first.articles).includes(article.id)), 'pages overlap');
  }
  return `${first.articles.length} on the first page`;
});

await test('unknown tickets give a clear error', async () => {
  expect((await fails('getConversation', { id: '999999999' })) === 'Ticket not found: 999999999', 'wrong error');
  expect((await fails('getConversation', { id: 'cnv_1' })) === 'Ticket not found or deleted', 'wrong error');
});

await test('sending tools are hidden without GROOVE_ALLOW_SEND', async () => {
  const { result } = await rpc('tools/list');
  const names = result.tools.map(tool => tool.name);
  const hidden = !names.includes('sendMessage') && !names.includes('createConversation');
  expect(hidden === !sends, 'wrong tool list');
  if (!sends) {
    expect((await fails('sendMessage', { conversationId: '1', to: 'a@b.c', body: 'x' }))?.includes('GROOVE_ALLOW_SEND'), 'not refused');
  }
});

await test('listDrafts returns only drafts of the ticket', async () => {
  const all = await call('listDrafts');
  if (all.length) {
    const own = await call('listDrafts', { conversationId: all[0].conversationId });
    expect(own.every(row => row.conversationId === all[0].conversationId), 'wrong ticket');
  }
  return `${all.length} drafts`;
});

if (drafts) {
  console.log('\nDrafts');
  const ticket = GROOVE_TEST_TICKET;
  const before = await call('getConversation', { id: ticket });
  const start = (await call('listDrafts', { conversationId: ticket })).length;

  await test('createReplyDraft saves a reply without sending', async () => {
    const draft = await call('createReplyDraft', { conversationId: ticket, body: 'Automated draft test.\nSecond line, <b>escaped</b>.' });
    expect(draft.saved && draft.sent === false, 'not saved');
    expect(draft.to.length === 1, 'no default recipient');
    expect(draft.body.includes('&lt;b&gt;'), 'text not escaped');
    expect(await fails('deleteDraft', { draftId: draft.draftId, conversationId: '999999999' }), 'deleted across tickets');
    expect((await call('deleteDraft', { draftId: draft.draftId, conversationId: ticket })).deleted, 'not deleted');
  });

  await test('createReplyDraft handles cc, bcc and reply-all', async () => {
    const draft = await call('createReplyDraft', { conversationId: ticket, body: '<div>Reply-all test</div>', cc: ['cc@example.com'], bcc: ['bcc@example.com'], replyAll: true });
    expect(draft.cc[0].email === 'cc@example.com' && draft.bcc[0].email === 'bcc@example.com', 'wrong recipients');
    await call('deleteDraft', { draftId: draft.draftId, conversationId: ticket });
  });

  await test('createReplyDraft saves a note draft', async () => {
    const draft = await call('createReplyDraft', { conversationId: ticket, body: 'Note draft test', note: true });
    expect(draft.type === 'note', 'not a note');
    expect(await fails('createReplyDraft', { conversationId: ticket, body: 'x', note: true, to: ['a@b.c'] }), 'note took recipients');
    await call('deleteDraft', { draftId: draft.draftId, conversationId: ticket });
  });

  await test('drafts leave no trace on the ticket', async () => {
    const after = await call('getConversation', { id: ticket });
    expect(after.counts.messages === before.counts.messages, 'a message appeared');
    expect(after.counts.notes === before.counts.notes, 'a note appeared');
    expect(after.state === before.state, 'state changed');
    expect((await call('listDrafts', { conversationId: ticket })).length === start, 'drafts left behind');
  });
}

if (update) {
  console.log('\nUpdating a ticket');

  // The server has no tool for these two, so they are asked of Groove directly
  const response = await fetch(process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROOVE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '{ me { id } teams(first: 100) { nodes { id agents(first: 100) { nodes { id } } } } }',
    }),
  });
  const { me, teams } = (await response.json()).data;

  // A team without other people, so nobody gets a notification
  const team = teams.nodes.find(row => row.agents.nodes.every(agent => agent.id === me.id));

  // Tickets made by --write. Everything below changes the ticket, so only those qualify
  const { conversations } = await call('listConversations', { keywords: 'groovehq-mcp live test' });
  const testTicket = conversations.find(row => row.subject.startsWith('[TEST]'));
  if (!testTicket) {
    console.error('No [TEST] ticket found. Run --write once to create one.');
    process.exit(1);
  }
  const id = String(testTicket.number);
  if (testTicket.assigned) {
    console.error(`Ticket ${id} is assigned, unassign it first.`);
    process.exit(1);
  }

  const tag = testTicket.tags.nodes[0]?.id ?? (await call('listTags', {}))[0].id;
  const hadTag = testTicket.tags.nodes.some(row => row.id === tag);
  const tagged = ticket => ticket.tags.nodes.some(row => row.id === tag);
  console.log(`  using ticket ${id}, ${team ? 'a team without other people' : 'no team, every team has other people'}`);

  await test('updateConversation adds and removes a tag', async () => {
    expect(tagged(await call('updateConversation', { id, tagIds: [tag] })), 'tag not added');
    expect(!tagged(await call('updateConversation', { id, removeTagIds: [tag] })), 'tag not removed');
  });

  await test('removing a tag the ticket does not have changes nothing', async () => {
    expect(!tagged(await call('updateConversation', { id, removeTagIds: [tag] })), 'tag came back');
  });

  await test('a tag cannot be added and removed at once', async () => {
    expect(await fails('updateConversation', { id, tagIds: [tag], removeTagIds: [tag] }), 'conflict allowed');
    expect(!tagged(await call('getConversation', { id })), 'tag changed');
  });

  await test('unassign removes an agent', async () => {
    const assigned = await call('updateConversation', { id, assignedAgentId: me.id });
    expect(assigned.assigned?.agent?.id === me.id, 'not assigned');
    expect(!(await call('updateConversation', { id, unassign: true })).assigned, 'still assigned');
  });

  await test('unassign does nothing on an unassigned ticket', async () => {
    expect(!(await call('updateConversation', { id, unassign: true })).assigned, 'assigned');
  });

  if (team) {
    await test('unassign removes a team', async () => {
      const assigned = await call('updateConversation', { id, assignedTeamId: team.id });
      expect(assigned.assigned?.team?.id === team.id, 'not assigned');
      expect(!(await call('updateConversation', { id, unassign: true })).assigned, 'still assigned');
    });

    await test('unassign removes an agent and a team together', async () => {
      await call('updateConversation', { id, assignedAgentId: me.id, assignedTeamId: team.id });
      const both = await call('getConversation', { id });
      expect(both.assigned?.agent?.id === me.id && both.assigned?.team?.id === team.id, 'not both assigned');
      expect(!(await call('updateConversation', { id, unassign: true })).assigned, 'still assigned');
    });

    await test('unassignAgent removes only the agent', async () => {
      await call('updateConversation', { id, assignedAgentId: me.id, assignedTeamId: team.id });
      const left = await call('updateConversation', { id, unassignAgent: true });
      expect(!left.assigned?.agent && left.assigned?.team?.id === team.id, 'wrong assignee left');
      await call('updateConversation', { id, unassign: true });
    });

    await test('unassignTeam removes only the team', async () => {
      await call('updateConversation', { id, assignedAgentId: me.id, assignedTeamId: team.id });
      const left = await call('updateConversation', { id, unassignTeam: true });
      expect(left.assigned?.agent?.id === me.id && !left.assigned?.team, 'wrong assignee left');
      await call('updateConversation', { id, unassign: true });
    });

    await test('unassign with a new assignee hands the ticket over', async () => {
      await call('updateConversation', { id, assignedAgentId: me.id });
      const moved = await call('updateConversation', { id, unassign: true, assignedTeamId: team.id });
      expect(!moved.assigned?.agent && moved.assigned?.team?.id === team.id, 'not handed over');
      await call('updateConversation', { id, unassign: true });
    });
  }

  await test('ticket is back as it was', async () => {
    if (hadTag) await call('updateConversation', { id, tagIds: [tag] });
    const after = await call('getConversation', { id });
    expect(after.state === testTicket.state, 'state changed');
    expect(tagged(after) === hadTag, 'tag not restored');
    expect(!after.assigned, 'assignee left behind');
    expect(after.counts.messages === testTicket.counts.messages, 'a message appeared');
    expect(after.counts.notes === testTicket.counts.notes, 'a note appeared');
  });
}

if (write) {
  const { createInterface: prompt } = await import('node:readline/promises');
  const input = prompt({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`\nSend 2 test mails to ${GROOVE_TEST_TO}? Type yes: `);
  input.close();

  if (answer !== 'yes') {
    console.log('Skipped the write tests.');
  } else {
    console.log('\nWriting');
    let number;
    const [local, domain] = GROOVE_TEST_TO.split('@');
    const cc = `${local}+cc@${domain}`;
    const bcc = `${local}+bcc@${domain}`;

    // No tool shows the recipients of a sent mail, so this asks Groove directly
    const copies = async () => {
      const response = await fetch(process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROOVE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: ID!) { events(filter: { conversationId: $id }, first: 20) { nodes { change { ... on Reply {
            cc { nodes { ... on Contact { email } } } bcc { nodes { ... on Contact { email } } } } } } } }`,
          variables: { id: `cnv_${number}` },
        }),
      });
      const { data } = await response.json();
      return data.events.nodes.map(row => row.change).filter(change => change?.cc);
    };
    const hasCopies = mail =>
      mail.cc.nodes.some(row => row.email === cc) && mail.bcc.nodes.some(row => row.email === bcc);

    await test('createConversation sends a mail', async () => {
      const created = await call('createConversation', { channelId: GROOVE_TEST_CHANNEL,
        to: GROOVE_TEST_TO,
        subject: '[TEST] groovehq-mcp live test',
        body: 'Automated groovehq-mcp test. Feel free to ignore.',
        cc: [cc],
        bcc: [bcc],
      });
      expect(created.contact.email === GROOVE_TEST_TO, 'wrong contact');
      number = `${created.number}`;
      return `ticket ${number}`;
    });

    await test('logConversation starts a ticket with a note and sends nothing', async () => {
      const whoAmI = await fetch(process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROOVE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ me { id } }' }),
      });
      const agent = (await whoAmI.json()).data.me;
      const result = await call('logConversation', {
        channelId: GROOVE_TEST_CHANNEL,
        to: `${local}+log@${domain}`,
        toName: 'Log Test',
        subject: '[TEST] groovehq-mcp log test',
        body: 'Automated groovehq-mcp log test.',
        state: 'closed',
        skipNotifications: true,
        assignedAgentId: agent.id,
      });
      expect(result.logged && result.sent === false, 'wrong result');
      expect(result.ticket.assigned?.agent?.id === agent.id, 'not assigned');
      expect(result.ticket.counts.notes === 1 && result.ticket.counts.messages === 0, 'not a note');
      expect(result.ticket.state === 'CLOSED', 'wrong state');
      expect(result.ticket.contact.email === `${local}+log@${domain}`, 'wrong contact');
      expect(await fails('logConversation', { channelId: 'ch_0', to: 'a@b.c', subject: 'x', body: 'x' }), 'wrong channel accepted');
      return `ticket ${result.ticket.number}`;
    });

    if (number) {
      await test('sendMessage sends a reply', async () => {
        const reply = await call('sendMessage', { conversationId: number,
          to: GROOVE_TEST_TO,
          body: 'Automated groovehq-mcp test reply.',
          cc: [cc],
          bcc: [bcc],
        });
        expect(reply.counts.messages === 2, 'reply not counted');
      });

      await test('createConversation and sendMessage send cc and bcc', async () => {
        const mails = await copies();
        expect(mails.length === 2 && mails.every(hasCopies), 'copies missing');
      });

      await test('createNote adds a note', async () => {
        const note = await call('createNote', { conversationId: number, body: 'Automated test note.' });
        expect(note.counts.notes === 1, 'note not counted');
      });

      await test('updateConversation changes state and tags', async () => {
        const updated = await call('updateConversation', { id: number, state: 'snoozed', tagIds: [tags[0].id] });
        expect(updated.state === 'SNOOZED', 'not snoozed');
        expect(ids(updated.tags.nodes).includes(tags[0].id), 'tag missing');
      });

      await test('a failed update reports what already happened', async () => {
        const message = await fails('updateConversation', { id: number, state: 'opened', tagIds: ['tag_0'] });
        expect(message?.includes('already applied: state'), 'no report of the applied step');
      });

      await test('closeConversation', async () => {
        expect((await call('closeConversation', { id: number })).state === 'CLOSED', 'not closed');
      });
    }
  }
}

if (merge) {
  const { createInterface: prompt } = await import('node:readline/promises');
  const input = prompt({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`\nSend 3 test mails around ${GROOVE_TEST_TO} and merge those tickets? Type yes: `);
  input.close();

  if (answer !== 'yes') {
    console.log('Skipped the merge tests.');
  } else {
    console.log('\nMerging');
    const [name, domain] = GROOVE_TEST_TO.split('@');
    const create = (to, letter) =>
      call('createConversation', { channelId: GROOVE_TEST_CHANNEL,
        to,
        subject: `[TEST] groovehq-mcp merge test ${letter}`,
        body: 'Automated groovehq-mcp merge test. Feel free to ignore.',
      });

    // Groove refuses to merge while a new mail is still waiting to go out
    const mergeWhenSent = async args => {
      for (let tries = 0; ; tries++) {
        const message = await fails('mergeConversations', { confirm: true, ...args });
        if (!message) return;
        if (!message.includes('waiting to be sent') || tries === 24) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    };

    // A plus address is another contact in Groove, delivered to the same mailbox
    const first = await create(GROOVE_TEST_TO, 'A');
    const second = await create(GROOVE_TEST_TO, 'B');
    const other = await create(`${name}+merge@${domain}`, 'C');
    const [source, target, foreign] = [first, second, other].map(row => String(row.number));
    console.log(`  using tickets ${source}, ${target} and ${foreign}`);

    await test('mergeConversations is marked as destructive', async () => {
      const { result } = await rpc('tools/list');
      const tool = result.tools.find(row => row.name === 'mergeConversations');
      expect(tool?.annotations?.destructiveHint === true, 'no destructive hint');
    });

    await test('a ticket cannot be merged into itself', async () => {
      expect(await fails('mergeConversations', { confirm: true, sourceId: source, targetId: source }), 'merged into itself');
    });

    await test('different contacts are refused and nothing changes', async () => {
      const message = await fails('mergeConversations', { confirm: true, sourceId: foreign, targetId: target });
      expect(message?.includes('allowDifferentContacts'), 'not refused');
      expect((await call('getConversation', { id: foreign })).state === other.state, 'source changed');
    });

    await test('a draft on the source is refused and kept', async () => {
      const draft = await call('createReplyDraft', { conversationId: source, body: 'Merge test draft.' });
      const message = await fails('mergeConversations', { confirm: true, sourceId: source, targetId: target });
      expect(message?.includes('discardDrafts'), 'not refused');
      expect((await call('listDrafts', { conversationId: source })).some(row => row.draftId === draft.draftId), 'draft gone');
    });

    await test('discardDrafts merges and deletes the draft', async () => {
      await mergeWhenSent({ sourceId: source, targetId: target, discardDrafts: true });
      expect((await call('getConversation', { id: target })).counts.messages === 2, 'messages not moved');
      expect(!(await call('listDrafts', { conversationId: target })).length, 'draft moved');
    });

    await test('a merged ticket says where it went', async () => {
      for (const id of [source, first.id]) {
        const message = await fails('getConversation', { id });
        expect(message?.includes(`merged into #${target}`), `got: ${message}`);
      }
    });

    await test('allowDifferentContacts merges and keeps the target contact', async () => {
      await mergeWhenSent({ sourceId: foreign, targetId: target, allowDifferentContacts: true });
      const ticket = await call('getConversation', { id: target });
      expect(ticket.contact.email === GROOVE_TEST_TO, 'wrong contact');
      expect(ticket.counts.messages === 3, 'messages not moved');
    });

    await test('merged tickets keep every message', async () => {
      expect((await call('listMessages', { conversationId: target })).length === 3, 'wrong message count');
    });

    await test('closeConversation closes the merged ticket', async () => {
      expect((await call('closeConversation', { id: target })).state === 'CLOSED', 'not closed');
    });
  }
}

server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
