import { describe, expect, test } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGrooveServer } from '../dist/server.js';

const READ = [
  'getAgent', 'getAttachment', 'getChannel', 'getContact', 'getContactProfile', 'getConversation', 'getRawEmail', 'listAgents', 'listCannedReplies', 'listChannels', 'listCompanies',
  'listContacts', 'listConversations', 'listDrafts', 'listFolders', 'listMessages', 'listRules', 'listTags', 'listTeams',
  'searchKbArticles',
];
const ADDITIVE = [
  'closeConversation', 'createContact', 'createNote', 'createReplyDraft', 'deleteConversation', 'logConversation', 'reactToNote',
  'restoreConversation', 'updateConversation',
];
const DESTRUCTIVE = [
  'createConversation', 'deleteContact', 'deleteContacts', 'deleteConversationPermanently', 'deleteDraft', 'deleteNote',
  'editNote', 'forwardConversation', 'markAsSpam', 'mergeContacts', 'mergeConversations', 'sendMessage', 'undoSend',
  'updateCompany', 'updateContact',
];

async function listTools(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createGrooveServer({ token: 'test', ...options }).connect(serverSide);
  const client = new Client({ name: 'annotations-test', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const names = tools => tools.map(tool => tool.name).sort();

describe('tool annotations', () => {
  const everything = { allowSend: true, allowSendAs: true, allowMerge: true, allowPermanentDelete: true };

  test('every tool sets readOnlyHint', async () => {
    const tools = await listTools(everything);
    expect(names(tools)).toEqual([...READ, ...ADDITIVE, ...DESTRUCTIVE].sort());
    for (const tool of tools) expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
  });

  test('read tools are exactly the ones left in read-only mode', async () => {
    const tools = await listTools(everything);
    const hinted = tools.filter(tool => tool.annotations.readOnlyHint);
    expect(names(hinted)).toEqual([...READ].sort());
    expect(names(await listTools({ readOnly: true }))).toEqual([...READ].sort());
  });

  test('every write tool sets destructiveHint to its class', async () => {
    const tools = await listTools(everything);
    const writes = tools.filter(tool => !tool.annotations.readOnlyHint);
    for (const tool of writes) expect(typeof tool.annotations.destructiveHint).toBe('boolean');
    expect(names(writes.filter(tool => tool.annotations.destructiveHint))).toEqual([...DESTRUCTIVE].sort());
    expect(names(writes.filter(tool => !tool.annotations.destructiveHint))).toEqual([...ADDITIVE].sort());
  });
});
