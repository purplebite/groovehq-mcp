import { GrooveClient } from '../groove-client.js';
import { Channel } from '../types/groove.js';
import { defineTool, READ_TOOL } from './definition.js';

const CHANNEL_FIELDS = `
  ... on Channel {
    __typename
    id
    name
    type
    conversationCount
    color
    state
    senderName
    createdAt
    updatedAt
    ... on EmailChannel {
      email
      fromName
      useAgentName
    }
  }
`;

interface ListChannelsArgs {
  limit?: number;
}

export class ChannelTools {
  constructor(private client: GrooveClient) {}

  async listChannels(args: ListChannelsArgs = {}): Promise<Channel[]> {
    const query = `
      query ListChannels($first: Int) {
        channels(first: $first) {
          nodes {
            ${CHANNEL_FIELDS}
          }
        }
      }
    `;

    const variables = {
      first: args.limit || 50,
    };

    const response = await this.client.request<{
      channels: {
        nodes: Channel[];
      };
    }>(query, variables);

    return response.channels.nodes;
  }

  async getChannel(id: string): Promise<Channel | null> {
    const query = `
      query GetChannel($id: ID!) {
        node(id: $id) {
          ${CHANNEL_FIELDS}
        }
      }
    `;

    const response = await this.client.request<{
      node: Channel | null;
    }>(query, { id });

    return response.node;
  }
}

export const listChannels = defineTool<ListChannelsArgs>({
  name: 'listChannels',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List all available channels/inboxes',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of channels to return',
        default: 50,
      },
    },
  },
  handler: (args, { channels }) => channels.listChannels(args),
});

export const getChannel = defineTool<{ id: string }>({
  name: 'getChannel',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'Get detailed information about a specific channel',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The channel ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, { channels }) => {
    const result = await channels.getChannel(args.id);
    if (!result) {
      throw new Error(`Channel not found: ${args.id}`);
    }
    return result;
  },
});
