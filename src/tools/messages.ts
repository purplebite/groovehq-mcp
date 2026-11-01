import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Conversation, Message } from '../types/groove.js';

interface ListMessagesArgs {
  conversationId: string;
  limit?: number;
}

interface SendMessageArgs {
  conversationId: string;
  to: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

interface CreateNoteArgs {
  conversationId: string;
  body: string;
}

export class MessageTools {
  constructor(private client: GrooveClient) {}

  async listMessages(args: ListMessagesArgs): Promise<Message[]> {
    const conversationId = await this.client.resolveConversationId(args.conversationId);
    const messages: Message[] = [];
    let after: string | undefined;
    let hasNextPage = true;

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
      after = response.events.pageInfo.endCursor;
    }

    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return args.limit ? messages.slice(-args.limit) : messages;
  }

  async sendMessage(args: SendMessageArgs) {
    const payload = await this.client.mutate<{ conversation: Conversation; changesetId: string }>(
      mutations.conversationReply,
      'conversationReply',
      {
        conversationId: await this.client.resolveConversationId(args.conversationId),
        to: args.to,
        body: args.body,
        cc: args.cc,
        bcc: args.bcc,
      }
    );

    return { ...payload.conversation, changesetId: payload.changesetId };
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

  async deleteNote(messageId: string) {
    await this.client.mutate(mutations.conversationDeleteNote, 'conversationDeleteNote', {
      messageId,
    });

    return { deleted: true, messageId };
  }

  async createNote(args: CreateNoteArgs): Promise<Conversation> {
    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationAddNote,
      'conversationAddNote',
      {
        conversationId: await this.client.resolveConversationId(args.conversationId),
        body: args.body,
      }
    );

    return payload.conversation;
  }
}
