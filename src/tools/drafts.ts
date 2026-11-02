import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { Draft } from '../types/groove.js';
import { defineTool, ADDITIVE_TOOL, DESTRUCTIVE_TOOL, READ_TOOL } from './definition.js';

interface ListDraftsArgs {
  conversationId?: string;
}

interface CreateReplyDraftArgs {
  conversationId: string;
  body: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyAll?: boolean;
  note?: boolean;
}

interface DeleteDraftArgs {
  draftId: string;
  conversationId: string;
}

interface DraftTicket {
  id: string;
  number: number;
  channel: { id: string };
  contact: {
    id: string;
    email: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

// Node 18 has no global crypto, and a draft ID only has to be unique
function newDraftId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Groove stores drafts as HTML, one <div> per line
function toHtml(body: string): string {
  if (/^\s*</.test(body)) return body;
  return body
    .split('\n')
    .map(line => `<div>${escapeHtml(line) || '<br>'}</div>`)
    .join('');
}

export class DraftTools {
  constructor(private client: GrooveClient) {}

  async listDrafts(args: ListDraftsArgs = {}): Promise<Draft[]> {
    const conversationId = args.conversationId
      ? await this.client.resolveConversationId(args.conversationId)
      : undefined;
    const drafts: Draft[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('drafts');

    while (hasNextPage) {
      const response = await this.client.request<{
        drafts: {
          nodes: Draft[];
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(queries.listDrafts, {
        first: 50,
        after,
        filter: conversationId ? { conversationId } : undefined,
      });

      drafts.push(...response.drafts.nodes);
      hasNextPage = response.drafts.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.drafts.pageInfo.endCursor);
    }

    // Groove ignores a filter it can't parse and returns every draft
    return conversationId ? drafts.filter(d => d.conversationId === conversationId) : drafts;
  }

  async createReplyDraft(args: CreateReplyDraftArgs) {
    if (args.note && (args.to || args.cc || args.bcc || args.replyAll)) {
      throw new Error('A note draft has no recipients: leave out to, cc, bcc and replyAll');
    }

    const conversationId = await this.client.resolveConversationId(args.conversationId);
    const response = await this.client.request<{ node: DraftTicket | null }>(
      queries.getDraftTicket,
      { id: conversationId }
    );
    const ticket = response.node;
    if (!ticket) throw new Error(`Ticket not found: ${args.conversationId}`);

    const body = toHtml(args.body);
    const existing = await this.listDrafts({ conversationId });
    const draftType = args.note ? 'NOTE' : 'REPLY';
    const draftId = newDraftId();

    await this.client.mutate(mutations.draftUpsert, 'draftUpsert', {
      draftId,
      conversationId,
      version: 1,
      draftType,
      // Groove rejects REPLY_ALL as a type and any other key in the payload.
      // The fields the web app uses belong in metadata.
      payload: args.note ? { body } : this.replyPayload(ticket, body, args),
      metadata: {
        ticketId: String(ticket.number),
        mailboxId: ticket.channel.id.replace(/^ch_/, ''),
        ...(args.note ? {} : { replyType: args.replyAll ? 'reply-all' : 'reply' }),
      },
    });

    const draft = (await this.listDrafts({ conversationId })).find(d => d.draftId === draftId);
    if (!draft) throw new Error('Groove accepted the draft but did not store it');

    return {
      saved: true,
      sent: false,
      draftId,
      ticket: ticket.number,
      type: args.note ? 'note' : 'reply',
      replyType: args.note ? undefined : args.replyAll ? 'reply-all' : 'reply',
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      body: draft.body,
      visibleTo: draft.agent?.email,
      inTheApp: `Nothing was sent. Open ticket #${ticket.number} in Groove as ${draft.agent?.email}: drafts are only visible to the agent who owns them.`,
      warning: existing.some(d => d.draftType === draftType)
        ? 'This ticket already had a draft of this type from this agent. Both now exist, and Groove may show only one.'
        : undefined,
    };
  }

  async deleteDraft(args: DeleteDraftArgs) {
    const conversationId = await this.client.resolveConversationId(args.conversationId);
    const drafts = await this.listDrafts({ conversationId });

    // draftDelete takes only a draft ID, so the ticket is checked here
    if (!drafts.some(d => d.draftId === args.draftId)) {
      throw new Error(
        `Draft ${args.draftId} is not on ticket ${args.conversationId}, or belongs to another agent`
      );
    }

    await this.client.mutate(mutations.draftDelete, 'draftDelete', { draftId: args.draftId });

    return { deleted: true, draftId: args.draftId };
  }

  private replyPayload(ticket: DraftTicket, body: string, args: CreateReplyDraftArgs) {
    const contact = ticket.contact;
    const recipient = (email: string) =>
      contact && email.toLowerCase() === contact.email.toLowerCase()
        ? { ...contact, __typename: 'Contact' }
        : { email };

    const to = args.to?.length ? args.to.map(recipient) : contact ? [recipient(contact.email)] : [];
    if (!to.length) throw new Error('This ticket has no contact: pass a to address');

    return {
      to,
      cc: (args.cc ?? []).map(email => ({ email })),
      bcc: (args.bcc ?? []).map(email => ({ email })),
      body,
    };
  }
}

export const listDrafts = defineTool<ListDraftsArgs>({
  name: 'listDrafts',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List your own unsent drafts, optionally for one ticket. Read-only. Drafts of other agents are not visible through the API.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
    },
  },
  handler: (args, { drafts }) => drafts.listDrafts(args),
});

export const createReplyDraft = defineTool<CreateReplyDraftArgs>({
  name: 'createReplyDraft',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description: 'Save a reply or note on a ticket as a draft for a person to review. NEVER SENDS anything. Drafts always belong to an existing ticket and are visible only to the agent who owns the API token.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      body: {
        type: 'string',
        description: 'The draft text, as plain text or HTML',
      },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: "Recipient email addresses (default: the ticket's contact)",
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Cc email addresses',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bcc email addresses',
      },
      replyAll: {
        type: 'boolean',
        description: 'Mark the draft as reply-all in the app',
      },
      note: {
        type: 'boolean',
        description: 'Save an internal note draft instead of a reply; no recipients allowed',
      },
    },
    required: ['conversationId', 'body'],
  },
  handler: (args, { drafts }) => drafts.createReplyDraft(args),
});

export const deleteDraft = defineTool<DeleteDraftArgs>({
  name: 'deleteDraft',
  setting: 'write',
  annotations: DESTRUCTIVE_TOOL,
  description: 'Delete one of your own drafts from a ticket',
  inputSchema: {
    type: 'object',
    properties: {
      draftId: {
        type: 'string',
        description: 'The draftId returned by listDrafts or createReplyDraft',
      },
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID the draft belongs to',
      },
    },
    required: ['draftId', 'conversationId'],
  },
  handler: (args, { drafts }) =>
    drafts.deleteDraft({ draftId: args.draftId, conversationId: args.conversationId }),
});
