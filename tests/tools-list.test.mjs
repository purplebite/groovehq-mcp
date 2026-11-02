import { describe, expect, test } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGrooveServer } from '../dist/server.js';

// Records the exact tools/list output (names, order, inputSchema, annotations)
// for every combination of the six boolean options, so a refactor can't change it.
const OPTIONS = ['readOnly', 'allowSend', 'allowSendAs', 'allowMerge', 'allowPermanentDelete', 'allowAttachments'];

async function listTools(options) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createGrooveServer({ token: 'test', ...options }).connect(serverSide);
  const client = new Client({ name: 'tools-list-test', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tools/list', () => {
  test('is unchanged for all 64 option combinations', async () => {
    // Each distinct tool definition is stored once; every combination lists the
    // definitions it returns, in order.
    const definitions = {};
    const keyOf = new Map();
    const combinations = {};

    for (let mask = 0; mask < 2 ** OPTIONS.length; mask++) {
      const options = Object.fromEntries(OPTIONS.map((name, bit) => [name, (mask & (1 << bit)) !== 0]));
      const label = OPTIONS.filter(name => options[name]).join(' + ') || '(all off)';
      const tools = await listTools(options);
      combinations[label] = tools.map(tool => {
        const json = JSON.stringify(tool);
        if (!keyOf.has(json)) {
          const variants = Object.keys(definitions).filter(key => key.split(' ')[0] === tool.name).length;
          const key = variants === 0 ? tool.name : `${tool.name} (${variants + 1})`;
          keyOf.set(json, key);
          definitions[key] = tool;
        }
        return keyOf.get(json);
      });
    }

    expect(Object.keys(combinations)).toHaveLength(64);
    expect({ definitions, combinations }).toMatchSnapshot();
  });
});
