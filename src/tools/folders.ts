import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { Folder, FolderOwner } from '../types/groove.js';
import { TeamTools } from './teams.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

interface FolderNode {
  id: string;
  name: string;
  channelRestriction: 'ALL' | 'SPECIFIC';
  restriction: { teams: FolderOwner[] | null; agents: FolderOwner[] | null } | null;
  channels: { nodes: FolderOwner[] };
  conditions: { nodes: Array<{ param: string; operator: string; value: string | null }> };
}

export class FolderTools {
  constructor(private client: GrooveClient) {}

  async listFolders(): Promise<Folder[]> {
    const teams = new Map((await new TeamTools(this.client).listTeams()).map(team => [team.id, team]));
    const folders = new Map<string, Folder>();
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.client.request<{
        folders: {
          nodes: FolderNode[];
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(queries.listFolders, {
        first: PAGE_SIZE,
        after,
        // Groove lists folders this agent can't open too, and fails on their tickets
        filter: { state: 'ACTIVE', scope: 'CURRENT_USER' },
      });

      for (const folder of response.folders.nodes) {
        // A name of only punctuation is a divider in the sidebar
        if (/^[\s\p{P}]*$/u.test(folder.name)) continue;

        // Conditions give a team as a bare number, without the tm_ of its ID
        const rule = folder.conditions.nodes.find(row => row.param === 'ASSIGNED_GROUP' && row.operator === 'EQ');
        const team = teams.get(`tm_${rule?.value}`);

        folders.set(folder.id, {
          id: folder.id,
          name: folder.name,
          teams: folder.restriction?.teams ?? [],
          agents: folder.restriction?.agents ?? [],
          channels: folder.channelRestriction === 'ALL' ? 'all' : folder.channels.nodes,
          assignedTeam: team ? { id: team.id, name: team.name } : null,
        });
      }

      if (!response.folders.pageInfo.hasNextPage) break;
      after = response.folders.pageInfo.endCursor;
    }

    return [...folders.values()];
  }
}
