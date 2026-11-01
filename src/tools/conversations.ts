import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Conversation } from '../types/groove.js';
import { DraftTools } from './drafts.js';

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
  unassign?: boolean;
  unassignAgent?: boolean;
  unassignTeam?: boolean;
  tagIds?: string[];
  removeTagIds?: string[];
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

interface MergeConversationsArgs {
  sourceId: string;
  targetId: string;
  allowDifferentContacts?: boolean;
  discardDrafts?: boolean;
}

interface MergeTicket {
  id: string;
  number: number;
  contact: { id: string; email: string } | null;
}

export class ConversationTools {
  private drafts: DraftTools;

  constructor(private client: GrooveClient) {
    this.drafts = new DraftTools(client);
  }

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
    if (args.removeTagIds?.some(tagId => args.tagIds?.includes(tagId))) {
      throw new Error('A tag cannot be in both tagIds and removeTagIds');
    }

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

    // Runs before assigning, so unassign plus a new assignee hands the ticket over
    const unassignAgent = args.unassign || args.unassignAgent;
    const unassignTeam = args.unassign || args.unassignTeam;
    if (unassignAgent || unassignTeam) {
      await apply('unassign', mutations.conversationUnassign, 'conversationUnassign', {
        agent: unassignAgent,
        team: unassignTeam,
      });
    }

    if (args.assignedAgentId || args.assignedTeamId) {
      await apply('assignee', mutations.conversationAssign, 'conversationAssign', {
        agentId: args.assignedAgentId,
        teamId: args.assignedTeamId,
      });
    }

    if (args.removeTagIds?.length) {
      await apply('removed tags', mutations.conversationUntag, 'conversationUntag', {
        tagIds: args.removeTagIds,
      });
    }

    if (args.tagIds) {
      await apply('tags', mutations.conversationTag, 'conversationTag', { tagIds: args.tagIds });
    }

    if (!conversation) {
      throw new Error(
        'Provide at least one of state, assignedAgentId, assignedTeamId, unassign, unassignAgent, unassignTeam, tagIds or removeTagIds'
      );
    }

    return conversation;
  }

  async mergeConversations(args: MergeConversationsArgs) {
    const sourceId = await this.client.resolveConversationId(args.sourceId);
    const targetId = await this.client.resolveConversationId(args.targetId);
    if (sourceId === targetId) throw new Error('Cannot merge a ticket into itself');

    const source = await this.mergeTicket(sourceId);
    const target = await this.mergeTicket(targetId);

    if (!args.allowDifferentContacts && source.contact?.id !== target.contact?.id) {
      throw new Error(
        `Ticket #${source.number} is from ${source.contact?.email} and #${target.number} from ${target.contact?.email}. ` +
          `After a merge the conversation only shows under ${target.contact?.email}. ` +
          'Ask the user, then pass allowDifferentContacts to go ahead.'
      );
    }

    // Groove deletes the drafts on the source, and only the token owner's are visible here
    const drafts = await this.drafts.listDrafts({ conversationId: sourceId });
    if (drafts.length && !args.discardDrafts) {
      throw new Error(
        `Ticket #${source.number} has ${drafts.length} unsent draft(s), and a merge deletes them. ` +
          'Ask the user, then pass discardDrafts to go ahead.'
      );
    }

    const payload = await this.client.mutate<{ target: Conversation }>(
      mutations.conversationMerge,
      'conversationMerge',
      { sourceId, targetId }
    );

    return {
      merged: true,
      mergedTicket: source.number,
      discardedDrafts: drafts.length,
      ticket: payload.target,
    };
  }

  private async mergeTicket(id: string): Promise<MergeTicket> {
    const response = await this.client.request<{ node: MergeTicket | null }>(
      queries.getDraftTicket,
      { id }
    );
    if (!response.node) throw new Error(`Ticket not found: ${id}`);
    return response.node;
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
