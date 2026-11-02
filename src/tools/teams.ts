import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { Team } from '../types/groove.js';
import { defineTool, READ_TOOL } from './definition.js';

export class TeamTools {
  constructor(private client: GrooveClient) {}

  async listTeams(): Promise<Team[]> {
    const teams: Team[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('teams');

    while (hasNextPage) {
      const response = await this.client.request<{
        teams: {
          nodes: Team[];
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(queries.listTeams, { first: 100, after });

      teams.push(...response.teams.nodes);
      hasNextPage = response.teams.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.teams.pageInfo.endCursor);
    }

    return teams;
  }
}

export const listTeams = defineTool({
  name: 'listTeams',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List all teams, for filtering or assigning tickets',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: (_args, { teams }) => teams.listTeams(),
});
