import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { Agent } from '../types/groove.js';
import { defineTool, READ_TOOL } from './definition.js';

export class AgentTools {
  constructor(private client: GrooveClient) {}

  async listAgents(): Promise<Agent[]> {
    const agents: Agent[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('agents');

    while (hasNextPage) {
      const response = await this.client.request<{
        agents: {
          nodes: Agent[];
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(queries.listAgents, { first: 100, after });

      agents.push(...response.agents.nodes);
      hasNextPage = response.agents.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.agents.pageInfo.endCursor);
    }

    return agents;
  }

  async getAgent(id: string): Promise<Agent | null> {
    // Since Groove doesn't have a specific getAgent query, we'll list all agents
    // and find the one with the matching ID
    const agents = await this.listAgents();
    return agents.find(agent => agent.id === id) || null;
  }

  // Groove acts as the token owner when it doesn't know the author, so check first
  async checkAuthor(authorId: string): Promise<void> {
    const agent = await this.getAgent(authorId);
    if (!agent) throw new Error(`Unknown agent: ${authorId}`);
    if (agent.state !== 'ACTIVE') throw new Error(`Agent ${authorId} is not active`);
  }
}

export const listAgents = defineTool({
  name: 'listAgents',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List all agents in the organization',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: (_args, { agents }) => agents.listAgents(),
});

export const getAgent = defineTool<{ id: string }>({
  name: 'getAgent',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'Get detailed information about a specific agent',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The agent ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, { agents }) => {
    const result = await agents.getAgent(args.id);
    if (!result) {
      throw new Error(`Agent not found: ${args.id}`);
    }
    return result;
  },
});
