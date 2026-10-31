import { GrooveClient } from '../groove-client.js';
import { Channel } from '../types/groove.js';

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