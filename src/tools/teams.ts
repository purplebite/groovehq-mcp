import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { Team } from '../types/groove.js';
import { defineTool, READ_TOOL } from './definition.js';

export class TeamTools {
  constructor(private client: GrooveClient) {}

  async listTeams(args: { includeMembers?: boolean } = {}): Promise<Team[]> {
    const teams: Team[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('teams');

    while (hasNextPage) {
      const response = await this.client.request<{
        teams: {
          nodes: Array<Team & { agents?: { nodes: Array<{ id: string; name: string; email: string }>; pageInfo: { hasNextPage: boolean } } }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(args.includeMembers ? queries.listTeamsWithMembers : queries.listTeams, { first: 100, after });

      for (const { agents, ...team } of response.teams.nodes) {
        if (!args.includeMembers) {
          teams.push(team);
          continue;
        }
        // Rather an error than a team that silently looks smaller than it is
        if (agents?.pageInfo.hasNextPage) throw new Error(`Team ${team.name} has more than 100 members, which listTeams can't show`);
        teams.push({ ...team, members: agents?.nodes ?? [] });
      }
      hasNextPage = response.teams.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.teams.pageInfo.endCursor);
    }

    return teams;
  }
}

export const listTeams = defineTool<{ includeMembers?: boolean }>({
  name: 'listTeams',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List all teams, for filtering or assigning tickets. With includeMembers, each team also lists its agents',
  inputSchema: {
    type: 'object',
    properties: {
      includeMembers: {
        type: 'boolean',
        description: 'Also list the agents in each team (id, name, email)',
      },
    },
  },
  handler: (args, { teams }) => teams.listTeams(args),
});
