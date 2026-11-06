import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { pageGuard } from '../utils/paging.js';
import { Conversation, Message } from '../types/groove.js';
import { AgentTools } from './agents.js';
import { AttachmentArg, uploadAttachments } from './attachments.js';
import { defineTool, ADDITIVE_TOOL, DESTRUCTIVE_TOOL, READ_TOOL } from './definition.js';

const MAX_RAW_CHARS = 100000;

interface ListMessagesArgs {
  conversationId: string;
  limit?: number;
  from?: 'start' | 'end';
  format?: 'full' | 'plain';
}

interface SendMessageArgs {
  conversationId: string;
  to: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  attachments?: AttachmentArg[];
  authorId?: string;
}

interface CreateNoteArgs {
  conversationId: string;
  body: string;
  mentionAgentIds?: string[];
  attachments?: AttachmentArg[];
  authorId?: string;
}

// The only form Groove turns into a tag. It silently drops the span when the username doesn't exist
const mentionTag = (username: string) => `<span class="mention">@${username}</span>`;

export class MessageTools {
  constructor(private client: GrooveClient) {}

  async listMessages(args: ListMessagesArgs): Promise<Array<Message | Omit<Message, 'body'>>> {
    const conversationId = await this.client.resolveConversationId(args.conversationId);
    const messages: Message[] = [];
    let after: string | undefined;
    let hasNextPage = true;
    const nextPage = pageGuard('messages');

    // Events list every message, unlike event groups, which show one per group
    while (hasNextPage) {
      const response = await this.client.request<{
        events: {
          nodes: Array<{ change: Partial<Message> | null }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string;
          };
        };
      }>(queries.listEvents, {
        // Without this filter, one broken history item fails the whole list
        filter: { conversationId, eventType: ['MESSAGE_CREATED'] },
        first: 50,
        after,
      });

      for (const event of response.events.nodes) {
        if (event.change?.id) messages.push(event.change as Message);
      }

      hasNextPage = response.events.pageInfo.hasNextPage;
      if (hasNextPage) after = nextPage(response.events.pageInfo.endCursor);
    }

    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const picked = !args.limit ? messages : args.from === 'start' ? messages.slice(0, args.limit) : messages.slice(-args.limit);
    // The HTML body is often twice the size of the plain text
    if (args.format !== 'plain') return picked;
    return picked.map(message => {
      const plain: Partial<Message> = { ...message };
      delete plain.body;
      return plain as Omit<Message, 'body'>;
    });
  }

  // The mail as it arrived, for checking where it really came from. Notes and some messages have none
  async getRawEmail(args: { messageId: string }) {
    const response = await this.client.request<{
      rawEmail: { headers: Array<{ name: string; value: string }> | null; bodyPlainText: string | null } | null;
    }>(queries.getRawEmail, { messageId: args.messageId });
    if (!response.rawEmail) throw new Error(`No original email for message ${args.messageId}; notes and messages written in Groove have none`);
    const text = response.rawEmail.bodyPlainText ?? '';
    return {
      messageId: args.messageId,
      headers: response.rawEmail.headers ?? [],
      bodyPlainText: text.length > MAX_RAW_CHARS ? `${text.slice(0, MAX_RAW_CHARS)}\n\n[truncated at ${MAX_RAW_CHARS} chars]` : text,
    };
  }

  // Groove only moves a message into a ticket of its own; mergeConversations puts it back.
  // listMessages on the old ticket still shows the moved message, as it does for other moved mail
  async moveMessageToNewTicket(args: { messageId: string }) {
    const payload = await this.client.mutate<{ conversation: { id: string; number: number; subject: string | null } }>(
      mutations.conversationMoveMessage,
      'conversationMoveMessage',
      { messageId: args.messageId },
    );
    if (!payload.conversation) throw new Error(`Groove did not move message ${args.messageId}`);
    return { moved: args.messageId, newTicket: payload.conversation };
  }

  async sendMessage(args: SendMessageArgs) {
    const conversationId = await this.client.resolveConversationId(args.conversationId);
    let channelId: string | undefined;
    if (args.authorId != null) {
      await new AgentTools(this.client).checkAuthor(args.authorId);
      // Groove fails without saying why when another author replies without the mailbox
      const { node } = await this.client.request<{ node: Conversation | null }>(queries.getConversation, {
        id: conversationId,
      });
      channelId = node?.channel?.id;
    }

    const payload = await this.client.mutate<{ conversation: Conversation; changesetId: string; message: { id: string; body: string } | null }>(
      mutations.conversationReply,
      'conversationReply',
      {
        conversationId,
        to: args.to,
        body: args.body,
        cc: args.cc,
        bcc: args.bcc,
        attachments: await uploadAttachments(this.client, args.attachments),
        authorId: args.authorId,
        channelId,
      }
    );

    // The reply as Groove stored it, so the caller can check what went out
    return { ...payload.conversation, changesetId: payload.changesetId, reply: payload.message ?? undefined };
  }

  async undoSend(conversationId: string, changesetId: string) {
    await this.client.mutate(mutations.conversationUndoSend, 'conversationUndoSend', {
      conversationId: await this.client.resolveConversationId(conversationId),
      changesetId,
    });

    return { undone: true, changesetId };
  }

  async editNote(messageId: string, body: string) {
    await this.client.mutate(mutations.conversationEditNote, 'conversationEditNote', {
      messageId,
      body,
    });

    return { edited: true, messageId };
  }

  async reactToNote(messageId: string, reaction: string) {
    await this.client.mutate(
      mutations.conversationToggleNoteReaction,
      'conversationToggleNoteReaction',
      { messageId, reaction }
    );

    return { toggled: true, messageId, reaction };
  }

  async deleteNote(messageId: string) {
    await this.client.mutate(mutations.conversationDeleteNote, 'conversationDeleteNote', {
      messageId,
    });

    return { deleted: true, messageId };
  }

  async createNote(args: CreateNoteArgs) {
    if (args.authorId != null) await new AgentTools(this.client).checkAuthor(args.authorId);
    const usernames = args.mentionAgentIds?.length ? await this.mentionNames(args.mentionAgentIds) : [];
    const body = usernames.length ? `${usernames.map(mentionTag).join(' ')} ${args.body}` : args.body;

    const payload = await this.client.mutate<{ conversation: Conversation; message: { id: string; body: string } | null }>(
      mutations.conversationAddNote,
      'conversationAddNote',
      {
        conversationId: await this.client.resolveConversationId(args.conversationId),
        body,
        attachments: await uploadAttachments(this.client, args.attachments),
        authorId: args.authorId,
      }
    );

    // The stored body shows whether Groove kept each tag
    const note = payload.message ?? undefined;
    const dropped = note ? usernames.filter(username => !note.body.includes(mentionTag(username))) : [];
    return { ...payload.conversation, note, ...(dropped.length ? { mentionsDropped: dropped } : {}) };
  }

  // Looked up before the note is placed, so a wrong ID never leaves a note without its tag
  private async mentionNames(ids: string[]): Promise<string[]> {
    const agents = await new AgentTools(this.client).listAgents();
    return ids.map(id => {
      const agent = agents.find(candidate => candidate.id === id);
      if (!agent) throw new Error(`Unknown agent: ${id}`);
      if (agent.state !== 'ACTIVE') throw new Error(`Agent ${id} is not active, so they can't be tagged`);
      if (!agent.username || !/^[\w.-]+$/.test(agent.username)) throw new Error(`Agent ${id} has no username to tag`);
      return agent.username;
    });
  }
}

export const undoSend = defineTool<{ conversationId: string; changesetId: string }>({
  name: 'undoSend',
  setting: 'send',
  annotations: DESTRUCTIVE_TOOL,
  description: 'Cancel a mail just sent with sendMessage or forwardConversation. Only works right after sending, while Groove has not sent it yet.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      changesetId: {
        type: 'string',
        description: 'The changesetId that sendMessage or forwardConversation returned',
      },
    },
    required: ['conversationId', 'changesetId'],
  },
  handler: (args, { messages }) => messages.undoSend(args.conversationId, args.changesetId),
});

export const editNote = defineTool<{ messageId: string; body: string }>({
  name: 'editNote',
  setting: 'write',
  annotations: DESTRUCTIVE_TOOL,
  description: 'Change the text of an internal note. Use listMessages to find its ID.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'ID of the note',
      },
      body: {
        type: 'string',
        description: 'New text of the note',
      },
    },
    required: ['messageId', 'body'],
  },
  handler: (args, { messages }) => messages.editNote(args.messageId, args.body),
});

export const reactToNote = defineTool<{ messageId: string; reaction: string }>({
  name: 'reactToNote',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description: 'Add a reaction to an internal note, or remove it if this agent already gave that reaction. Groove does not show reactions through the API.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'ID of the note',
      },
      reaction: {
        type: 'string',
        description: 'The emoji, for example 👍',
      },
    },
    required: ['messageId', 'reaction'],
  },
  handler: (args, { messages }) => messages.reactToNote(args.messageId, args.reaction),
});

export const deleteNote = defineTool<{ messageId: string }>({
  name: 'deleteNote',
  setting: 'write',
  annotations: DESTRUCTIVE_TOOL,
  description: 'Delete an internal note. Confirm with the user first.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'ID of the note',
      },
    },
    required: ['messageId'],
  },
  handler: (args, { messages }) => messages.deleteNote(args.messageId),
});

export const listMessages = defineTool<ListMessagesArgs>({
  name: 'listMessages',
  setting: 'read',
  annotations: READ_TOOL,
  description: 'List messages and notes in a conversation, oldest first. Groove can still return notes that were deleted, and mail that was moved to another ticket',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      limit: {
        type: 'number',
        description: 'Return only this many messages (default: all), counted from the end unless from is start',
      },
      from: {
        type: 'string',
        enum: ['start', 'end'],
        description: 'Which end limit counts from: end (default) gives the latest messages, start gives the first ones, such as the original question',
      },
      format: {
        type: 'string',
        enum: ['full', 'plain'],
        description: 'plain leaves out the HTML body and keeps bodyPlainText, which makes the result about half the size (default: full)',
      },
    },
    required: ['conversationId'],
  },
  handler: (args, { messages }) => messages.listMessages(args),
});

export const getRawEmail = defineTool<{ messageId: string }>({
  name: 'getRawEmail',
  setting: 'read',
  annotations: READ_TOOL,
  description:
    'Get the original email behind a message, with all its headers (Received, From, Return-Path, authentication results), to check where a mail really came from, for example with phishing or delivery problems',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The message ID from listMessages (msg_...)',
      },
    },
    required: ['messageId'],
  },
  handler: (args, { messages }) => messages.getRawEmail(args),
});

export const moveMessageToNewTicket = defineTool<{ messageId: string }>({
  name: 'moveMessageToNewTicket',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description:
    'Take one message out of its ticket and make it a new ticket, for example when a customer raises something new in an old thread. Groove can only move it to a new ticket. To put it back, merge the new ticket into the old one with mergeConversations; Groove refuses that for the first few minutes after the move ("a message waiting to be sent")',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The message ID from listMessages (msg_...)',
      },
    },
    required: ['messageId'],
  },
  handler: (args, { messages }) => messages.moveMessageToNewTicket(args),
});

export const sendMessage = defineTool<SendMessageArgs>({
  name: 'sendMessage',
  setting: 'send',
  annotations: DESTRUCTIVE_TOOL,
  description: 'SENDS AN EMAIL IMMEDIATELY as a reply on a ticket. Use only when the user explicitly asks to send this message; to prepare a reply for review, use createReplyDraft. Returns the ticket and the reply as Groove stored it.',
  inputSchema: ({ authorField, attachmentsField }) => ({
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      to: {
        type: 'string',
        description: 'Email address of the recipient',
      },
      body: {
        type: 'string',
        description: 'The message body content',
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
    },
    required: ['conversationId', 'to', 'body'],
  }),
  handler: (args, { messages }) => messages.sendMessage(args),
});

export const createNote = defineTool<CreateNoteArgs>({
  name: 'createNote',
  setting: 'write',
  annotations: ADDITIVE_TOOL,
  description:
    'Create an internal note in a conversation. Returns the ticket and the note as Groove stored it. To tag colleagues so they get a notification, pass mentionAgentIds',
  inputSchema: ({ authorField, attachmentsField }) => ({
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'Ticket number (e.g. 12345) or conversation ID',
      },
      body: {
        type: 'string',
        description:
          'The note as HTML. Line breaks need <p> or <br>, because plain newlines are dropped. A tag written by hand is <span class="mention">@username</span>, with the username from listAgents; plain @name text is not a tag',
      },
      mentionAgentIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent IDs to tag at the start of the note. Each one is checked first; an unknown or inactive agent stops the note',
      },
      ...attachmentsField,
      ...authorField,
    },
    required: ['conversationId', 'body'],
  }),
  handler: (args, { messages }) => messages.createNote(args),
});
