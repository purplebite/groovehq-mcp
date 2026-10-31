import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { Agent } from '../types/groove.js';

export class AgentTools {
  constructor(private client: GrooveClient) {}

  async listAgents(): Promise<Agent[]> {
    const agents: Agent[] = [];
    let after: string | undefined;
    let hasNextPage = true;

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
      after = response.agents.pageInfo.endCursor;
    }

    return agents;
  }

  async getAgent(id: string): Promise<Agent | null> {
    // Since Groove doesn't have a specific getAgent query, we'll list all agents
    // and find the one with the matching ID
    const agents = await this.listAgents();
    return agents.find(agent => agent.id === id) || null;
  }
}