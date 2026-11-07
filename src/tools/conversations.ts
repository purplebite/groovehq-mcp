import { Variables } from 'graphql-request';
import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Conversation } from '../types/groove.js';
import { AgentTools } from './agents.js';
import { DraftTools } from './drafts.js';
import { AttachmentArg, uploadAttachments } from './attachments.js';
import { pageGuard } from '../utils/paging.js';
import { defineTool, ADDITIVE_TOOL, DESTRUCTIVE_TOOL, READ_TOOL } from './definition.js';

const PROVIDERS = [
  'JIRA_CLOUD', 'JIRA_SERVER', 'GITHUB', 'GITHUB_LEGACY', 'LINEAR', 'TRELLO', 'HUBSPOT', 'SALESFORCE',
  'SHOPIFY', 'SHOPIFY_V2', 'STRIPE', 'RECHARGE', 'MICROSOFT_OFFICE_365', 'GOOGLE', 'OPTIMIZECX', 'CHAT',
];

interface LinkResourceArgs {
  conversationId: string;
  provider: string;
  externalId: string;
  title: string;
  url: string;
  remove?: boolean;
}

type ConversationStateArg = 'unread' | 'opened' | 'closed' | 'snoozed' | 'spam';

interface ListConversationsArgs {
  state?: ConversationStateArg;
  states?: ConversationStateArg[];
  assignedAgentId?: string;
  assignedTeamId?: string;
  contactId?: string;
  contactEmail?: string;
  channelId?: string;
  folderId?: string;
  tagIds?: string[];
  tagNames?: string[];
  keywords?: string;
  mentionedAgentId?: string;
  draftAuthorId?: string;
  draftType?: 'reply' | 'reply_all' | 'note';
  rating?: 'any' | 'awesome' | 'ok' | 'bad';
  starred?: boolean;
  deleted?: boolean;
  type?: Array<'email' | 'chat' | 'widget' | 'facebook' | 'twitter'>;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  orderBy?: {
    field: 'CREATED_AT' | 'UPDATED_AT' | 'STATE_CHANGED_AT' | 'LAST_UNANSWERED_USER_MESSAGE_AT';
    direction?: 'ASC' | 'DESC';
  };
  limit?: number;
  after?: string;
}

// Groove wants a full date and time; a date alone counts as midnight UTC
function toDateTime(key: string, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be a date, like 2026-10-01 or 2026-10-01T09:00:00Z`);
  return date.toISOString();
}

interface ListConversationsResult {
  conversations: Conversation[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  totalCount: number;
  totalCountCapped: boolean;
}

interface UpdateConversationArgs {
  id: string;
  state?: 'opened' | 'closed' | 'snoozed' | 'unread';
  subject?: string;
  contactId?: string;
  channelId?: string;
  allowNoAccess?: boolean;
  starred?: boolean;
  followerIds?: string[];
  removeFollowerIds?: string[];
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
  cc?: string[];
  bcc?: string[];
  attachments?: AttachmentArg[];
  authorId?: string;
  state?: 'opened' | 'closed' | 'snoozed';
  snoozedUntil?: string;
}

interface LogConversationArgs {
  channelId: string;
  to: string;
  toName?: string;
  phone?: string;
  subject: string;
  body: string;
  state?: 'opened' | 'closed';
  assignedAgentId?: string;
  assignedTeamId?: string;
  skipNotifications?: boolean;
  attachments?: AttachmentArg[];
  authorId?: string;
}

// The states Groove can restore a ticket to, without spam
const RESTORE_STATES = ['UNREAD', 'OPENED', 'CLOSED'];

interface ForwardConversationArgs {
  conversationId: string;
  to: string[];
  body: string;
  subject?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: AttachmentArg[];
}

interface ConfirmedTicketArgs {
  id: string;
  confirm?: boolean;
}

interface MergeConversationsArgs {
  sourceId: string;
  targetId: string;
  confirm?: boolean;
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
    const filter: {
      state?: string;
      states?: string[];
      assigned?: { agent?: string; team?: string };
      contactId?: string;
      contactEmail?: string;
      channelId?: string;
      folderId?: string;
      tags?: string[];
      tagNames?: string[];
      keywords?: string;
      mentionedAgent?: string;
      draftAuthor?: string;
      draftType?: string;
      rating?: string;
      starred?: boolean;
      deleted?: boolean;
      type?: string[];
      afterCreatedAt?: string;
      beforeCreatedAt?: string;
      afterUpdatedAt?: string;
      beforeUpdatedAt?: string;
    } = {};

    if (args.state) filter.state = args.state.toUpperCase();
    if (args.states?.length) filter.states = args.states.map(state => state.toUpperCase());
    if (args.contactEmail) filter.contactEmail = args.contactEmail;
    if (args.tagNames?.length) filter.tagNames = args.tagNames;
    if (args.mentionedAgentId) filter.mentionedAgent = args.mentionedAgentId;
    if (args.draftAuthorId) filter.draftAuthor = args.draftAuthorId;
    if (args.draftType) filter.draftType = args.draftType.toUpperCase();
    if (args.rating) filter.rating = args.rating.toUpperCase();
    if (args.starred !== undefined) filter.starred = args.starred;
    if (args.deleted !== undefined) filter.deleted = args.deleted;
    if (args.type?.length) filter.type = args.type.map(type => type.toUpperCase());
    if (args.updatedAfter) filter.afterUpdatedAt = toDateTime('updatedAfter', args.updatedAfter);
    if (args.updatedBefore) filter.beforeUpdatedAt = toDateTime('updatedBefore', args.updatedBefore);
    if (args.assignedAgentId) filter.assigned = { agent: args.assignedAgentId };
    if (args.assignedTeamId) filter.assigned = { ...filter.assigned, team: args.assignedTeamId };
    if (args.contactId) filter.contactId = args.contactId;
    if (args.channelId) filter.channelId = args.channelId;
    if (args.folderId) filter.folderId = args.folderId;
    if (args.tagIds) filter.tags = args.tagIds;
    if (args.keywords) filter.keywords = args.keywords;
    if (args.createdAfter) filter.afterCreatedAt = toDateTime('createdAfter', args.createdAfter);
    if (args.createdBefore) filter.beforeCreatedAt = toDateTime('createdBefore', args.createdBefore);
    const orderBy = args.orderBy ? { field: args.orderBy.field, direction: args.orderBy.direction ?? 'DESC' } : undefined;

    const response = await this.client.request<{
      conversations: {
        nodes: Conversation[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        totalCount: number;
        totalCountCapped: boolean;
      };
    }>(queries.listConversations, { first: args.limit || 20, after: args.after, filter, orderBy }).catch((error: Error) => {
      if (!args.folderId) throw error;
      if (error.message.includes('No folder found')) throw new Error(`Folder not found: ${args.folderId}`);
      // Groove gives this for a folder that's turned off or limited to other agents
      if (error.message.includes('Cannot return null')) {
        throw new Error(`Folder not available to this agent: ${args.folderId}`);
      }
      throw error;
    });

    return {
      conversations: response.conversations.nodes,
      pageInfo: response.conversations.pageInfo,
      totalCount: response.conversations.totalCount,
      totalCountCapped: response.conversations.totalCountCapped,
    };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const response = await this.client.request<{
      node: Conversation | null;
    }>(queries.getConversation, { id: await this.client.resolveConversationId(id) });

    return response.node;
  }

  async createConversation(args: CreateConversationArgs): Promise<Conversation> {
    if (args.snoozedUntil && args.state !== 'snoozed') {
      throw new Error('snoozedUntil needs state snoozed');
    }
    if (args.authorId != null) await new AgentTools(this.client).checkAuthor(args.authorId);

    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationCreateEmail,
      'conversationCreateEmail',
      {
        channelId: args.channelId,
        message: {
          subject: args.subject,
          body: args.body,
          to: [{ email: args.to, name: args.toName || args.to }],
          cc: args.cc?.map(email => ({ email, name: email })),
          bcc: args.bcc?.map(email => ({ email, name: email })),
          attachments: await uploadAttachments(this.client, args.attachments),
          authorId: args.authorId,
        },
        assigned: { agentId: args.assignedAgentId, teamId: args.assignedTeamId },
        tagIds: args.tagIds,
        state: args.state?.toUpperCase(),
        snoozeUntil: args.snoozedUntil,
      }
    );

    return payload.conversation;
  }

  // Groove's "Log a Conversation": a new ticket that starts with a note, so no mail goes out
  async logConversation(args: LogConversationArgs) {
    if (args.authorId != null) await new AgentTools(this.client).checkAuthor(args.authorId);

    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationLog,
      'conversationLog',
      {
        channelId: args.channelId,
        message: {
          subject: args.subject,
          body: args.body,
          to: { email: args.to, name: args.toName || args.to },
          phone: args.phone,
          attachments: await uploadAttachments(this.client, args.attachments),
        },
        assigned:
          args.assignedAgentId || args.assignedTeamId
            ? { agentId: args.assignedAgentId, teamId: args.assignedTeamId }
            : undefined,
        state: args.state?.toUpperCase(),
        skipNotifications: args.skipNotifications,
        authorId: args.authorId,
      }
    );

    return { logged: true, sent: false, ticket: payload.conversation };
  }

  async updateConversation(args: UpdateConversationArgs): Promise<Conversation> {
    if (args.removeTagIds?.some(tagId => args.tagIds?.includes(tagId))) {
      throw new Error('A tag cannot be in both tagIds and removeTagIds');
    }

    const conversationId = await this.client.resolveConversationId(args.id);
    // With allowNoAccess the move goes last, because afterwards nothing here can reach the ticket
    const moveLast = args.allowNoAccess === true;
    if (args.channelId && !moveLast && !(await this.hasChannelAccess(args.channelId))) {
      throw new Error(
        `This account has no access to mailbox ${args.channelId}, so after the move it couldn't read the ticket or move it back. ` +
          'Ask the user, then pass allowNoAccess to go ahead.'
      );
    }
    const applied: string[] = [];
    let conversation: Conversation | undefined;

    // Groove has no atomic update, so a failure reports the steps that already went through
    const apply = async (step: string, mutation: string, field: string, input: Variables) => {
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

    if (args.state === 'unread') {
      await apply('state', mutations.conversationUnread, 'conversationUnread', {});
    }

    if (args.subject !== undefined) {
      await apply('subject', mutations.conversationSubject, 'conversationSubject', {
        subject: args.subject,
      });
    }

    if (args.contactId) {
      await apply('contact', mutations.conversationChangeContact, 'conversationChangeContact', {
        contactId: args.contactId,
      });
    }

    const move = () =>
      apply('mailbox', mutations.conversationChangeChannel, 'conversationChangeChannel', {
        channelId: args.channelId,
      });
    if (args.channelId && !moveLast) await move();

    if (args.starred === true) {
      await apply('star', mutations.conversationStar, 'conversationStar', {});
    } else if (args.starred === false) {
      await apply('star', mutations.conversationUnstar, 'conversationUnstar', {});
    }

    if (args.followerIds?.length) {
      await apply('followers', mutations.conversationFollow, 'conversationFollow', {
        followerIds: args.followerIds,
      });
    }

    if (args.removeFollowerIds?.length) {
      await apply('followers', mutations.conversationUnfollow, 'conversationUnfollow', {
        followerIds: args.removeFollowerIds,
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

    if (args.channelId && moveLast) await move();

    if (!conversation) {
      throw new Error('Provide at least one change to make');
    }

    return conversation;
  }

  // A ticket in a mailbox this account can't see can't be read or moved back, and Groove
  // doesn't stop such a move itself, so access is checked first
  private async hasChannelAccess(channelId: string): Promise<boolean> {
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

    let ticket: { id: string } | undefined;
    try {
      const { conversations } = await this.client.request<{
        conversations: { nodes: Array<{ id: string }> };
      }>(queries.getChannelTicket, { filter: { channelId } });
      ticket = conversations.nodes[0];
    } catch (error) {
      // Groove refuses to list a mailbox the account can't access
      if (/no longer have access/i.test(reason(error))) return false;
      throw error;
    }
    // An empty mailbox can only be listed with access
    if (!ticket) return true;

    try {
      await this.client.request(queries.getTicketNode, { id: ticket.id });
      return true;
    } catch (error) {
      if (/hidden due to permissions/i.test(reason(error))) return false;
      throw error;
    }
  }

  async deleteConversation(args: ConfirmedTicketArgs) {
    const ticket = await this.ticketPreview(args.id);
    if (args.confirm !== true) return { deleted: false, wouldDelete: ticket, undo: 'restoreConversation brings it back' };
    await this.removeConversation(ticket.id, 'SOFT');
    return { deleted: true, ticket: ticket.number };
  }

  async deleteConversationPermanently(args: ConfirmedTicketArgs) {
    const ticket = await this.ticketPreview(args.id);
    if (args.confirm !== true) return { deleted: false, permanent: true, wouldDelete: ticket, undo: 'none: this cannot be undone' };
    await this.removeConversation(ticket.id, 'HARD');
    return { deleted: true, permanent: true, ticket: ticket.number };
  }

  // What the user needs to recognise a ticket before a change that asks first
  private async ticketPreview(id: string) {
    const ticket = await this.getConversation(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    return { id: ticket.id, number: ticket.number, subject: ticket.subject, contact: ticket.contact?.email ?? null, state: ticket.state };
  }

  private async removeConversation(conversationId: string, deleteMode: 'SOFT' | 'HARD'): Promise<void> {
    await this.client.mutate(mutations.conversationDelete, 'conversationDelete', {
      conversationIds: [conversationId],
      deleteMode,
    });
  }

  async listLinkedResources(conversationId: string) {
    const response = await this.client.request<{
      linkedResources: { nodes: Array<{ provider: string; externalId: string; title: string; url: string; createdAt: string }> };
    }>(queries.listLinkedResources, { filter: { conversationId: await this.client.resolveConversationId(conversationId) } });
    return response.linkedResources.nodes;
  }

  // Groove keeps the link with the ticket and shows it in its sidebar
  async linkResource(args: LinkResourceArgs) {
    // The link is shown to agents in Groove, so it must be a web address
    if (!/^https?:\/\//i.test(args.url)) throw new Error('url must start with https:// or http://');
    await this.client.mutate(mutations.conversationLinkResource, 'conversationLinkResource', {
      conversationId: await this.client.resolveConversationId(args.conversationId),
      provider: args.provider,
      externalId: args.externalId,
      title: args.title,
      url: args.url,
      removed: args.remove === true,
    });
    return { ticket: args.conversationId, [args.remove ? 'unlinked' : 'linked']: { provider: args.provider, externalId: args.externalId } };
  }

  // Spam reaches past this ticket, so it only goes through markAsSpam
  async markAsSpam(args: ConfirmedTicketArgs) {
    const ticket = await this.ticketPreview(args.id);
    if (args.confirm !== true) {
      return { spam: false, wouldMarkAsSpam: ticket, wouldBlacklist: ticket.contact, undo: 'restoreConversation brings the ticket back; the blacklist only goes in the Groove settings' };
    }
    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationSpam,
      'conversationSpam',
      { conversationId: ticket.id }
    );

    return payload.conversation;
  }

  async restoreConversation(id: string) {
    const conversationId = await this.client.resolveConversationId(id);
    await this.client.mutate(mutations.conversationRestore, 'conversationRestore', {
      conversationIds: [conversationId],
      newState: await this.stateBeforeRemoval(conversationId),
    });

    return this.getConversation(conversationId);
  }

  // Groove wants a state to restore to, and only the ticket's history shows what it was
  private async stateBeforeRemoval(conversationId: string): Promise<string> {
    const changes: Array<{ createdAt: string; to: string }> = [];
    const nextPage = pageGuard('state changes');
    let after: string | undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const { events } = await this.client.request<{
        events: {
          nodes: Array<{ createdAt: string; change: { to?: string } | null }>;
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }>(queries.listStateChanges, {
        filter: { conversationId, eventType: ['STATE_CHANGED'] },
        first: 50,
        after,
      });

      for (const event of events.nodes) {
        if (event.change?.to) changes.push({ createdAt: event.createdAt, to: event.change.to });
      }
      hasNextPage = events.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(events.pageInfo.endCursor);
    }

    changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return changes.find(change => RESTORE_STATES.includes(change.to))?.to ?? 'OPENED';
  }

  async forwardConversation(args: ForwardConversationArgs) {
    const conversationId = await this.client.resolveConversationId(args.conversationId);
    const ticket = await this.getConversation(conversationId);
    if (!ticket) throw new Error(`Ticket not found: ${args.conversationId}`);

    // Without a state Groove closes the ticket, and a subject renames it
    const payload = await this.client.mutate<{ conversation: Conversation; changesetId: string }>(
      mutations.conversationForwardV2,
      'conversationForwardV2',
      {
        conversationId,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        body: args.body,
        subject: args.subject,
        attachments: await uploadAttachments(this.client, args.attachments),
        state: ticket.state,
        snoozeUntil: ticket.snoozed?.until,
      }
    );

    return { ...payload.conversation, changesetId: payload.changesetId };
  }

  async mergeConversations(args: MergeConversationsArgs) {
    const sourceId = await this.client.resolveConversationId(args.sourceId);
    const targetId = await this.client.resolveConversationId(args.targetId);
    if (sourceId === targetId) throw new Error('Cannot merge a ticket into itself');

    const source = await this.mergeTicket(sourceId);
    const target = await this.mergeTicket(targetId);

    const sameContact = source.contact && source.contact.id === target.contact?.id;
    if (args.allowDifferentContacts !== true && !sameContact) {
      const sourceEmail = source.contact?.email ?? 'no contact';
      const targetEmail = target.contact?.email ?? 'no contact';
      throw new Error(
        `Ticket #${source.number} is from ${sourceEmail} and #${target.number} from ${targetEmail}. ` +
          `After a merge the conversation only shows under ${targetEmail}. ` +
          'Ask the user, then pass allowDifferentContacts to go ahead.'
      );
    }

    // Groove deletes the drafts on the source, and only the token owner's are visible here
    const drafts = await this.drafts.listDrafts({ conversationId: sourceId });
    if (drafts.length && args.discardDrafts !== true) {
      throw new Error(
        `Ticket #${source.number} has ${drafts.length} unsent draft(s), and a merge deletes them. ` +
          'Ask the user, then pass discardDrafts to go ahead.'
      );
    }

    if (args.confirm !== true) {
      return {
        merged: false,
        wouldMerge: {
          disappears: { number: source.number, contact: source.contact?.email ?? null },
          stays: { number: target.number, contact: target.contact?.email ?? null },
          draftsDeleted: drafts.length,
        },
      };
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

export const listConversations = defineTool<ListConversationsArgs>({
  name: 'listConversations',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List conversations with optional filters. Returns one page; if pageInfo.hasNextPage is true, more results exist. totalCount is the number of matching tickets across all pages, so for a count, ask for limit 1. If totalCountCapped is true, Groove stopped counting and the real number is higher',
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['unread', 'opened', 'closed', 'snoozed', 'spam'],
        description: 'Filter by conversation state. opened also includes unread, but leaves out snoozed: ask for snoozed separately to see every ticket that still needs work. For tickets in the trash, use deleted',
      },
      states: {
        type: 'array',
        items: { type: 'string', enum: ['unread', 'opened', 'closed', 'snoozed', 'spam'] },
        description: 'Tickets in any of these states, for example ["opened", "snoozed"]. Ignored when state is set',
      },
      assignedAgentId: {
        type: 'string',
        description: 'Filter by assigned agent ID',
      },
      assignedTeamId: {
        type: 'string',
        description: 'Filter by assigned team ID',
      },
      contactId: {
        type: 'string',
        description: 'Filter by contact ID',
      },
      contactEmail: {
        type: 'string',
        description: 'Only tickets from the contact with this email address',
      },
      channelId: {
        type: 'string',
        description: 'Filter by channel ID',
      },
      folderId: {
        type: 'string',
        description: "Only tickets in this Smart Folder. Get the ID from listFolders. Don't combine it with channelId, unless that mailbox is listed for the folder.",
      },
      tagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tag IDs',
      },
      tagNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tickets with any of these tag names, without looking up their IDs first',
      },
      mentionedAgentId: {
        type: 'string',
        description: 'Only tickets where this agent was @mentioned in a note',
      },
      draftAuthorId: {
        type: 'string',
        description: 'Only tickets where this agent has an unsent draft',
      },
      draftType: {
        type: 'string',
        enum: ['reply', 'reply_all', 'note'],
        description: 'Only tickets with an unsent draft of this kind',
      },
      rating: {
        type: 'string',
        enum: ['any', 'awesome', 'ok', 'bad'],
        description: "Only tickets whose latest customer rating is this; any means rated at all",
      },
      starred: {
        type: 'boolean',
        description: 'true for starred tickets only, false for tickets without a star',
      },
      deleted: {
        type: 'boolean',
        description: 'true for tickets in the trash only, false for tickets outside it',
      },
      type: {
        type: 'array',
        items: { type: 'string', enum: ['email', 'chat', 'widget', 'facebook', 'twitter'] },
        description: 'Only tickets that came in this way',
      },
      keywords: {
        type: 'string',
        description: 'Full-text search across conversations',
      },
      createdAfter: {
        type: 'string',
        description: 'Only tickets created on or after this moment, as an ISO date or date-time (2026-10-01 means midnight UTC)',
      },
      createdBefore: {
        type: 'string',
        description: 'Only tickets created on or before this moment, as an ISO date or date-time. For all of October, use 2026-10-31T23:59:59Z',
      },
      updatedAfter: {
        type: 'string',
        description: 'Only tickets updated on or after this moment, as an ISO date or date-time',
      },
      updatedBefore: {
        type: 'string',
        description: 'Only tickets updated on or before this moment, as an ISO date or date-time',
      },
      orderBy: {
        type: 'object',
        description: "Sort order. STATE_CHANGED_AT with state closed lists recently closed tickets first; each ticket's stateUpdatedAt is its latest state change",
        properties: {
          field: {
            type: 'string',
            enum: ['CREATED_AT', 'UPDATED_AT', 'STATE_CHANGED_AT', 'LAST_UNANSWERED_USER_MESSAGE_AT'],
          },
          direction: {
            type: 'string',
            enum: ['ASC', 'DESC'],
            default: 'DESC',
          },
        },
        required: ['field'],
      },
      limit: {
        type: 'number',
        description: 'Maximum number of conversations to return per page',
        default: 20,
      },
      after: {
        type: 'string',
        description: 'Cursor for the next page (pageInfo.endCursor from the previous result)',
      },
    },
  },
  handler: (args, { conversations }) => conversations.listConversations(args),
});

export const getConversation = defineTool<{ id: string }>({
  name: 'getConversation',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'Get detailed information about a specific conversation',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, { conversations }) => {
    const result = await conversations.getConversation(args.id);
    if (!result) {
      throw new Error(`Conversation not found: ${args.id}`);
    }
    return result;
  },
});

export const createConversation = defineTool<CreateConversationArgs>({
  name: 'createConversation',
  setting: 'send',
  annotations: DESTRUCTIVE_TOOL,
  description: 'SENDS AN EMAIL IMMEDIATELY to the given address and creates a ticket. Use only when the user explicitly asks to send this message.',
  inputSchema: ({ authorField, attachmentsField }) => ({
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'ID of the channel to send from',
      },
      to: {
        type: 'string',
        description: 'Email address of the recipient',
      },
      toName: {
        type: 'string',
        description: 'Name of the recipient (defaults to the email address)',
      },
      subject: {
        type: 'string',
        description: 'Subject of the conversation',
      },
      body: {
        type: 'string',
        description: 'Initial message body',
      },
      assignedAgentId: {
        type: 'string',
        description: 'ID of agent to assign the conversation to',
      },
      assignedTeamId: {
        type: 'string',
        description: 'ID of team to assign the conversation to',
      },
      tagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag IDs to apply to the conversation',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to send a copy to',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to send a hidden copy to',
      },
      ...attachmentsField,
      ...authorField,
      state: {
        type: 'string',
        enum: ['opened', 'closed', 'snoozed'],
        description: 'State of the new ticket',
        default: 'opened',
      },
      snoozedUntil: {
        type: 'string',
        description: 'ISO 8601 datetime to snooze until. Needs state snoozed. Leave out to snooze indefinitely',
      },
    },
    required: ['channelId', 'to', 'subject', 'body'],
  }),
  handler: (args, { conversations }) => conversations.createConversation(args),
});

export const logConversation = defineTool<LogConversationArgs>({
  name: 'logConversation',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description:
    "Groove's Log a Conversation: creates a ticket for a contact that starts with an internal note, for example to record a phone call. Never sends email.",
  inputSchema: ({ authorField, attachmentsField }) => ({
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'ID of the email channel for the ticket',
      },
      to: {
        type: 'string',
        description: 'Email address of the contact. A new contact is created if needed',
      },
      toName: {
        type: 'string',
        description: 'Name of the contact (defaults to the email address)',
      },
      phone: {
        type: 'string',
        description: 'Phone number of the contact, for example when logging a call',
      },
      subject: {
        type: 'string',
        description: 'Subject of the ticket',
      },
      body: {
        type: 'string',
        description: 'Text of the internal note',
      },
      state: {
        type: 'string',
        enum: ['opened', 'closed'],
        description: 'State of the new ticket',
        default: 'opened',
      },
      assignedAgentId: {
        type: 'string',
        description: 'ID of agent to assign the ticket to',
      },
      assignedTeamId: {
        type: 'string',
        description: 'ID of team to assign the ticket to',
      },
      skipNotifications: {
        type: 'boolean',
        description: 'Do not notify agents about the new ticket',
      },
      ...attachmentsField,
      ...authorField,
    },
    required: ['channelId', 'to', 'subject', 'body'],
  }),
  handler: (args, { conversations }) => conversations.logConversation(args),
});

export const updateConversation = defineTool<UpdateConversationArgs>({
  name: 'updateConversation',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description: 'Update a conversation (status, assignee, tags). Can also unassign and remove tags. To delete a ticket, use deleteConversation. To mark it as spam, use markAsSpam',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      state: {
        type: 'string',
        enum: ['opened', 'closed', 'snoozed', 'unread'],
        description: 'New conversation state',
      },
      subject: {
        type: 'string',
        description: 'New subject',
      },
      contactId: {
        type: 'string',
        description: 'Move the ticket to this contact. The sender of existing mail stays the same',
      },
      channelId: {
        type: 'string',
        description: 'Move the ticket to this mailbox. Refused if this account has no access to it, unless allowNoAccess is set',
      },
      allowNoAccess: {
        type: 'boolean',
        description: "Move even though this account has no access to the mailbox, so it can't read the ticket or move it back afterwards. Only after the user agreed",
      },
      starred: {
        type: 'boolean',
        description: 'Star or unstar the ticket',
      },
      followerIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to add as followers',
      },
      removeFollowerIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to remove as followers',
      },
      assignedAgentId: {
        type: 'string',
        description: 'ID of agent to assign the conversation to',
      },
      assignedTeamId: {
        type: 'string',
        description: 'ID of team to assign the conversation to',
      },
      unassign: {
        type: 'boolean',
        description:
          'Unassign the ticket: removes both the agent and the team. Use this unless asked to keep one of them. Add assignedAgentId or assignedTeamId to hand the ticket to someone else',
      },
      unassignAgent: {
        type: 'boolean',
        description: 'Remove only the agent. The team stays',
      },
      unassignTeam: {
        type: 'boolean',
        description: 'Remove only the team. The agent stays',
      },
      tagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag IDs to add to the conversation (existing tags are kept)',
      },
      removeTagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag IDs to remove from the conversation (other tags are kept)',
      },
      snoozedUntil: {
        type: 'string',
        description: 'ISO 8601 datetime to snooze until',
      },
    },
    required: ['id'],
  },
  hints: {
    state: {
      spam: 'Use markAsSpam to mark a ticket as spam',
      trashed: 'Use deleteConversation to delete a ticket',
      deleted: 'Use deleteConversation to delete a ticket',
    },
  },
  handler: (args, { conversations }) => conversations.updateConversation(args),
});

export const deleteConversation = defineTool<ConfirmedTicketArgs>({
  name: 'deleteConversation',
  setting: 'write',
  annotations: DESTRUCTIVE_TOOL,
  confirm: 'delete this ticket',
  description: 'Delete a ticket. It goes to the trash, and restoreConversation brings it back with its messages and notes. Without confirm it only shows which ticket would go: show that to the user first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: (args, { conversations }) => conversations.deleteConversation(args),
});

export const deleteConversationPermanently = defineTool<ConfirmedTicketArgs>({
  name: 'deleteConversationPermanently',
  setting: 'permanentDelete',
  annotations: DESTRUCTIVE_TOOL,
  confirm: 'delete this ticket for good',
  description: 'Delete a ticket for good. This cannot be undone. Without confirm it only shows which ticket would go: show that to the user first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: (args, { conversations }) => conversations.deleteConversationPermanently(args),
});

export const restoreConversation = defineTool<{ id: string }>({
  name: 'restoreConversation',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description: 'Restore a ticket from spam or deleted. It gets back the state it had before, opened if that is unknown',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: (args, { conversations }) => conversations.restoreConversation(args.id),
});

export const listLinkedResources = defineTool<{ conversationId: string }>({
  name: 'listLinkedResources',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List what a ticket is linked to in other systems through Groove, such as Jira issues, with title and link',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['conversationId'],
  },
  handler: (args, { conversations }) => conversations.listLinkedResources(args.conversationId),
});

export const linkResource = defineTool<LinkResourceArgs>({
  name: 'linkResource',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description:
    "Link a ticket to an item in another system, such as a Jira issue, so it shows in Groove's sidebar. With remove, the link goes again. It only records the link in Groove",
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      provider: {
        type: 'string',
        enum: PROVIDERS,
        description: 'The system the item lives in, for example JIRA_CLOUD',
      },
      externalId: {
        type: 'string',
        description: "The item's ID in that system, for example the Jira issue key IT-123",
      },
      title: {
        type: 'string',
        description: 'Title to show in Groove, for example the issue summary',
      },
      url: {
        type: 'string',
        description: 'Link to the item',
      },
      remove: {
        type: 'boolean',
        description: 'Remove this link instead of adding it',
      },
    },
    required: ['conversationId', 'provider', 'externalId', 'title', 'url'],
  },
  handler: (args, { conversations }) => conversations.linkResource(args),
});

export const markAsSpam = defineTool<ConfirmedTicketArgs>({
  name: 'markAsSpam',
  setting: 'write',
  annotations: DESTRUCTIVE_TOOL,
  confirm: 'mark this ticket as spam and blacklist its sender',
  description:
    'Mark a ticket as spam. Groove also blacklists the sender, so their future mail to any mailbox is marked as spam too. Without confirm it only shows the ticket and the address that would be blacklisted: show that to the user first. restoreConversation brings the ticket back, but the blacklist can only be undone in the Groove settings.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: (args, { conversations }) => conversations.markAsSpam(args),
});

export const forwardConversation = defineTool<ForwardConversationArgs>({
  name: 'forwardConversation',
  setting: 'send',
  annotations: DESTRUCTIVE_TOOL,
  description:
    'SENDS AN EMAIL IMMEDIATELY: forwards a ticket to the given addresses. The ticket keeps its state, and only gets a new subject if you pass one. Use only when the user explicitly asks.',
  inputSchema: ({ attachmentsField }) => ({
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to forward to',
      },
      body: {
        type: 'string',
        description: 'Message to add to the forward',
      },
      subject: {
        type: 'string',
        description: 'New subject. This also renames the ticket',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to send a copy to',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to send a hidden copy to',
      },
      ...attachmentsField,
    },
    required: ['conversationId', 'to', 'body'],
  }),
  handler: (args, { conversations }) => conversations.forwardConversation(args),
});

export const mergeConversations = defineTool<MergeConversationsArgs>({
  name: 'mergeConversations',
  setting: 'merge',
  annotations: DESTRUCTIVE_TOOL,
  confirm: 'merge these tickets',
  description:
    'Permanently merge one ticket into another. This cannot be undone. Without confirm it only shows both tickets and which one would disappear: show that to the user first. ' +
    'The source ticket disappears. The target keeps its contact, subject and assignee. Replies and notes move over and tags are combined. ' +
    'Drafts on the source are deleted, and an open source reopens the target',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: {
        type: 'string',
        description: 'Ticket that disappears: number (e.g. 12345) or conversation ID',
      },
      targetId: {
        type: 'string',
        description: 'Ticket that stays: number (e.g. 12345) or conversation ID',
      },
      allowDifferentContacts: {
        type: 'boolean',
        description: 'Merge even though the tickets have different contacts. Only after the user agreed',
      },
      discardDrafts: {
        type: 'boolean',
        description: 'Merge even though the source has drafts, which get deleted. Only after the user agreed',
      },
    },
    required: ['sourceId', 'targetId'],
  },
  handler: (args, { conversations }) => conversations.mergeConversations(args),
});

export const closeConversation = defineTool<{ id: string }>({
  name: 'closeConversation',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description: 'Close a conversation',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
    required: ['id'],
  },
  handler: (args, { conversations }) => conversations.closeConversation(args.id),
});
