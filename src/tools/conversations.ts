import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Conversation } from '../types/groove.js';

interface ListConversationsArgs {
  state?: 'unread' | 'opened' | 'closed' | 'snoozed';
  assignedAgentId?: string;
  assignedTeamId?: string;
  contactId?: string;
  channelId?: string;
  tagIds?: string[];
  keywords?: string;
  limit?: number;
  after?: string;
}

interface ListConversationsResult {
  conversations: Conversation[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface UpdateConversationArgs {
  id: string;
  state?: 'opened' | 'closed' | 'snoozed';
  assignedAgentId?: string;
  assignedTeamId?: string;
  tagIds?: string[];
  snoozedUntil?: string;
}

interface CreateConversationArgs {
  channelId: string;
  to: string;
  toName?: string;
  subject: string;
  body: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
  tagIds?: string[];
}

export class ConversationTools {
  constructor(private client: GrooveClient) {}

  async listConversations(args: ListConversationsArgs): Promise<ListConversationsResult> {
    const filter: any = {};

    if (args.state) filter.state = args.state.toUpperCase();
    if (args.assignedAgentId) filter.assigned = { agent: args.assignedAgentId };
    if (args.assignedTeamId) filter.assigned = { ...filter.assigned, team: args.assignedTeamId };
    if (args.contactId) filter.contactId = args.contactId;
    if (args.channelId) filter.channelId = args.channelId;
    if (args.tagIds) filter.tags = args.tagIds;
    if (args.keywords) filter.keywords = args.keywords;

    const response = await this.client.request<{
      conversations: {
        nodes: Conversation[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(queries.listConversations, { first: args.limit || 20, after: args.after, filter });

    return {
      conversations: response.conversations.nodes,
      pageInfo: response.conversations.pageInfo,
    };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const response = await this.client.request<{
      node: Conversation | null;
    }>(queries.getConversation, { id: await this.client.resolveConversationId(id) });

    return response.node;
  }

  async createConversation(args: CreateConversationArgs): Promise<Conversation> {
    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationCreateEmail,
      'conversationCreateEmail',
      {
        channelId: args.channelId,
        message: {
          subject: args.subject,
          body: args.body,
          to: [{ email: args.to, name: args.toName || args.to }],
        },
        assigned: { agentId: args.assignedAgentId, teamId: args.assignedTeamId },
        tagIds: args.tagIds,
      }
    );

    return payload.conversation;
  }

  async updateConversation(args: UpdateConversationArgs): Promise<Conversation> {
    const conversationId = await this.client.resolveConversationId(args.id);
    const applied: string[] = [];
    let conversation: Conversation | undefined;

    // Groove has no atomic update, so a failure reports the steps that already went through
    const apply = async (step: string, mutation: string, field: string, input: any) => {
      try {
        const payload = await this.client.mutate<{ conversation: Conversation }>(
          mutation,
          field,
          { conversationId, ...input }
        );
        conversation = payload.conversation;
        applied.push(step);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to update ${step}: ${message}` +
            (applied.length ? ` (already applied: ${applied.join(', ')})` : ' (nothing was changed)')
        );
      }
    };

    if (args.state === 'opened') {
      await apply('state', mutations.conversationOpen, 'conversationOpen', {});
    } else if (args.state === 'closed') {
      await apply('state', mutations.conversationClose, 'conversationClose', {});
    } else if (args.state === 'snoozed') {
      await apply('state', mutations.conversationSnooze, 'conversationSnooze', {
        until: args.snoozedUntil,
      });
    }

    if (args.assignedAgentId || args.assignedTeamId) {
      await apply('assignee', mutations.conversationAssign, 'conversationAssign', {
        agentId: args.assignedAgentId,
        teamId: args.assignedTeamId,
      });
    }

    if (args.tagIds) {
      await apply('tags', mutations.conversationTag, 'conversationTag', { tagIds: args.tagIds });
    }

    if (!conversation) {
      throw new Error('Provide at least one of state, assignedAgentId, assignedTeamId or tagIds');
    }

    return conversation;
  }

  async closeConversation(id: string): Promise<Conversation> {
    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationClose,
      'conversationClose',
      { conversationId: await this.client.resolveConversationId(id) }
    );

    return payload.conversation;
  }
}
