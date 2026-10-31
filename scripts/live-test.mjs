#!/usr/bin/env node
// Runs the built server against a real Groove account and checks every tool.
// Output holds only counts and ticket numbers, never message text.
//
//   GROOVE_API_TOKEN=... npm run test:live            changes nothing
//
//   GROOVE_API_TOKEN=... GROOVE_TEST_TO=you@example.com GROOVE_TEST_CHANNEL=ch_123 \
//     npm run test:live -- --write                    sends 2 test mails

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const write = process.argv.includes('--write');
const { GROOVE_API_TOKEN, GROOVE_TEST_TO, GROOVE_TEST_CHANNEL } = process.env;

if (!GROOVE_API_TOKEN) {
  console.error('Set GROOVE_API_TOKEN first.');
  process.exit(1);
}

if (write && (!GROOVE_TEST_TO || !GROOVE_TEST_CHANNEL)) {
  console.error('--write needs GROOVE_TEST_TO and GROOVE_TEST_CHANNEL.');
  process.exit(1);
}

const server = spawn('node', [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'ignore'],
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

await test('searchKbArticles', async () => `${(await call('searchKbArticles', { query: 'help' })).length} found`);

await test('unknown tickets give a clear error', async () => {
  expect((await fails('getConversation', { id: '999999999' })) === 'Ticket not found: 999999999', 'wrong error');
  expect((await fails('getConversation', { id: 'cnv_1' })) === 'Ticket not found or deleted', 'wrong error');
});

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

    await test('createConversation sends a mail', async () => {
      const created = await call('createConversation', {
        channelId: GROOVE_TEST_CHANNEL,
        to: GROOVE_TEST_TO,
        subject: '[TEST] groovehq-mcp live test',
        body: 'Automated groovehq-mcp test. Feel free to ignore.',
      });
      expect(created.contact.email === GROOVE_TEST_TO, 'wrong contact');
      number = `${created.number}`;
      return `ticket ${number}`;
    });

    if (number) {
      await test('sendMessage sends a reply', async () => {
        const reply = await call('sendMessage', {
          conversationId: number,
          to: GROOVE_TEST_TO,
          body: 'Automated groovehq-mcp test reply.',
        });
        expect(reply.counts.messages === 2, 'reply not counted');
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

server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
