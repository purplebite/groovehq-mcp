#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGrooveServer, GrooveClient } from './server.js';

const apiToken = process.env.GROOVE_API_TOKEN;
const apiUrl = process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql';

if (!apiToken) {
  console.error('Error: GROOVE_API_TOKEN environment variable is required');
  process.exit(1);
}

// Refuses anything else, because GROOVE_READ_ONLY=true must not start a server that writes
function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
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
});
const grooveClient = new GrooveClient(apiToken, apiUrl);

async function main() {
  console.error('Validating Groove API connection...');
  const isValid = await grooveClient.validateConnection();
  
  if (!isValid) {
    console.error('Failed to connect to Groove API. Please check your API token and URL.');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Groove MCP server started successfully');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
