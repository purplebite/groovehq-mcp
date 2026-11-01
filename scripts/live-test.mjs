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
const sends = write || merge;
const { GROOVE_API_TOKEN, GROOVE_TEST_TO, GROOVE_TEST_CHANNEL, GROOVE_TEST_TICKET } = process.env;

if (!GROOVE_API_TOKEN) {
  console.error('Set GROOVE_API_TOKEN first.');
  process.exit(1);
}

if (sends && (!GROOVE_TEST_TO || !GROOVE_TEST_CHANNEL)) {
  console.error('--write and --merge need GROOVE_TEST_TO and GROOVE_TEST_CHANNEL.');
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
  env: { ...process.env, GROOVE_ALLOW_SEND: sends ? '1' : '0', GROOVE_READ_ONLY: '0' },
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

  await test('deleteContacts deletes orphans and skips contacts with tickets', async () => {
    const contact = await create('b');
    const contactIds = [contact.id, owner.id];
    const dry = await call('deleteContacts', { contactIds });
    expect(dry.results[0].status === 'would delete' && dry.results[1].status === 'skipped', 'wrong dry run');
    expect(await exists(contact.email), 'deleted without confirm');
    const result = await call('deleteContacts', { contactIds, confirm: true });
    expect(result.deleted === 1 && result.skipped === 1, 'wrong result');
    expect((await settles(contact.email, false)) && (await exists(GROOVE_TEST_TO)), 'wrong contacts deleted');
  });

  await test('deleteContacts refuses more than 100 contacts', async () => {
    const contactIds = Array.from({ length: 101 }, (_, index) => `co_${index}`);
    expect(await fails('deleteContacts', { contactIds }), 'not refused');
  });

  await test('mergeContacts removes the source and keeps the target', async () => {
    const source = await create('c');
    const target = await create('d');
    expect(await fails('mergeContacts', { source: source.email, target: source.id }), 'merged into itself');
    const result = await call('mergeContacts', { source: source.email, target: target.id });
    expect(result.merged && result.contact.id === target.id, 'wrong result');
    expect((await settles(source.email, false)) && (await exists(target.email)), 'wrong contact left');
    await call('deleteContact', { email: target.email, confirm: true });
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

await test('searchKbArticles', async () => `${(await call('searchKbArticles', { query: 'help' })).length} found`);

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
      call('createConversation', {
        channelId: GROOVE_TEST_CHANNEL,
        to,
        subject: `[TEST] groovehq-mcp merge test ${letter}`,
        body: 'Automated groovehq-mcp merge test. Feel free to ignore.',
      });

    // Groove refuses to merge while a new mail is still waiting to go out
    const mergeWhenSent = async args => {
      for (let tries = 0; ; tries++) {
        const message = await fails('mergeConversations', args);
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
      expect(await fails('mergeConversations', { sourceId: source, targetId: source }), 'merged into itself');
    });

    await test('different contacts are refused and nothing changes', async () => {
      const message = await fails('mergeConversations', { sourceId: foreign, targetId: target });
      expect(message?.includes('allowDifferentContacts'), 'not refused');
      expect((await call('getConversation', { id: foreign })).state === other.state, 'source changed');
    });

    await test('a draft on the source is refused and kept', async () => {
      const draft = await call('createReplyDraft', { conversationId: source, body: 'Merge test draft.' });
      const message = await fails('mergeConversations', { sourceId: source, targetId: target });
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
