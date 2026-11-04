import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { defineTool, READ_TOOL } from './definition.js';

interface ListCannedRepliesArgs {
  keywords?: string;
  categoryIds?: string[];
  limit?: number;
  after?: string;
}

interface CannedReply {
  id: string;
  name: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  category: { id: string; name: string } | null;
  mailboxIds: string[] | null;
  countUsed: number;
  lastUsedAt: string | null;
}

export class CannedReplyTools {
  constructor(private client: GrooveClient) {}

  async listCannedReplies(args: ListCannedRepliesArgs = {}) {
    const filter: { keywords?: string; categoryIds?: string[] } = {};
    if (args.keywords) filter.keywords = args.keywords;
    if (args.categoryIds?.length) filter.categoryIds = args.categoryIds;

    const response = await this.client.request<{
      cannedReplies: {
        nodes: CannedReply[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        totalCount: number;
      };
    }>(queries.listCannedReplies, { first: args.limit || 20, after: args.after, filter });

    return {
      cannedReplies: response.cannedReplies.nodes,
      pageInfo: response.cannedReplies.pageInfo,
      totalCount: response.cannedReplies.totalCount,
    };
  }
}

export const listCannedReplies = defineTool<ListCannedRepliesArgs>({
  name: 'listCannedReplies',
  setting: 'read',
  annotations: READ_TOOL,
  description:
    "List the team's saved replies (canned replies), so a reply or draft can reuse their wording. Search with keywords or filter by category; each reply shows its category and the mailboxes it is meant for",
  inputSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        description: 'Words to search for in the name and text of the saved replies',
      },
      categoryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only saved replies in these categories (category IDs from earlier results)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of saved replies to return per page',
        default: 20,
      },
      after: {
        type: 'string',
        description: 'Cursor for the next page (pageInfo.endCursor from the previous result)',
      },
    },
  },
  handler: (args, { cannedReplies }) => cannedReplies.listCannedReplies(args),
});
