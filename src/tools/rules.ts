import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { defineTool, READ_TOOL } from './definition.js';

interface RawRule {
  id: string;
  name: string;
  description: string | null;
  state: string;
  matchType: string;
  mailboxScope: string;
  mailboxIds: string[];
  position: number;
  stopUpcoming: boolean;
  lastRunAt: string | null;
  totalExecutions: number;
  triggers: { nodes: Array<{ type: string; settings: unknown }> } | null;
  conditions: { nodes: Array<{ param: string; operator: string; value: string | null }> } | null;
  actions: { nodes: Array<{ type: string; value: string | null; toAgent: string | null }> } | null;
}

// Reading only: the MCP doesn't create or change rules, which is account management
export class RuleTools {
  constructor(private client: GrooveClient) {}

  async listRules(args: { state?: 'active' | 'inactive' } = {}) {
    if (args.state !== undefined && !['active', 'inactive'].includes(args.state)) throw new Error('state must be active or inactive');
    const filter = args.state ? { state: args.state.toUpperCase() } : undefined;
    const rules: RawRule[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('rules');

    while (hasNextPage) {
      const response = await this.client.request<{
        rules: { nodes: RawRule[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
      }>(queries.listRules, { first: 50, after, filter });
      rules.push(...response.rules.nodes);
      hasNextPage = response.rules.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.rules.pageInfo.endCursor);
    }

    return rules
      .sort((a, b) => a.position - b.position)
      .map(({ triggers, conditions, actions, ...rule }) => ({
        ...rule,
        triggers: triggers?.nodes ?? [],
        conditions: conditions?.nodes ?? [],
        actions: actions?.nodes ?? [],
      }));
  }
}

export const listRules = defineTool<{ state?: 'active' | 'inactive' }>({
  name: 'listRules',
  setting: 'read',
  annotations: READ_TOOL,
  description:
    "List Groove's automatic rules in the order they run: when each one fires, its conditions and actions, and how often it ran. Useful to explain why a ticket got a tag, an assignee or a status. Read only",
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['active', 'inactive'],
        description: 'Only active or only inactive rules (default: both)',
      },
    },
  },
  handler: (args, { rules }) => rules.listRules(args),
});
