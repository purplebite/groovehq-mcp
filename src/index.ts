#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGrooveServer, GrooveClient } from './server.js';

const apiToken = process.env.GROOVE_API_TOKEN;
const apiUrl = process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql';

if (!apiToken) {
  console.error('Error: GROOVE_API_TOKEN environment variable is required');
  process.exit(1);
}

const server = createGrooveServer({
  token: apiToken,
  apiUrl,
  readOnly: process.env.GROOVE_READ_ONLY === '1',
  allowSend: process.env.GROOVE_ALLOW_SEND === '1',
  allowMerge: process.env.GROOVE_ALLOW_MERGE !== '0',
  allowPermanentDelete: process.env.GROOVE_ALLOW_PERMANENT_DELETE === '1',
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
