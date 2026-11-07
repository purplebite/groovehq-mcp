#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGrooveServer, GrooveClient, checkApiUrl } from './server.js';

const apiToken = process.env.GROOVE_API_TOKEN;
const apiUrl = process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql';

if (!apiToken) {
  console.error('Error: GROOVE_API_TOKEN environment variable is required');
  process.exit(1);
}

try {
  checkApiUrl(apiUrl);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

// Refuses anything else, because GROOVE_READ_ONLY=true must not start a server that writes
function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === '1') return true;
  if (value === '0') return false;

  console.error(`Error: ${name} must be 1 or 0, got "${value}"`);
  process.exit(1);
}

const server = createGrooveServer({
  token: apiToken,
  apiUrl,
  readOnly: flag('GROOVE_READ_ONLY', false),
  allowSend: flag('GROOVE_ALLOW_SEND', false),
  allowSendAs: flag('GROOVE_ALLOW_SEND_AS', false),
  allowMerge: flag('GROOVE_ALLOW_MERGE', true),
  allowPermanentDelete: flag('GROOVE_ALLOW_PERMANENT_DELETE', false),
  allowAttachments: flag('GROOVE_ALLOW_ATTACHMENTS', false),
  readAttachments: flag('GROOVE_READ_ATTACHMENTS', true),
});
const grooveClient = new GrooveClient(apiToken, apiUrl);

async function main() {
  // The SDK closes the connection on a message over 10 MB. An attachment of the
  // allowed 20 MB is about 27 MB as base64, so it gets refused with an error instead
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 32 * 1024 * 1024 });
  // Connected first, so a client with a short startup timeout doesn't give up on a slow Groove.
  // A bad token then shows in the log here, and in the error of the first tool call
  await server.connect(transport);
  console.error('Groove MCP server started successfully');

  if (!(await grooveClient.validateConnection())) {
    console.error('Warning: could not reach Groove with this API token. Tool calls will fail until GROOVE_API_TOKEN and GROOVE_API_URL are right.');
  }
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
