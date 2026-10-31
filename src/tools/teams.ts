import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { Team } from '../types/groove.js';

export class TeamTools {
  constructor(private client: GrooveClient) {}

  async listTeams(): Promise<Team[]> {
    const teams: Team[] = [];
    let after: string | undefined;
    let hasNextPage = true;

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
      after = response.teams.pageInfo.endCursor;
    }

    return teams;
  }
}
