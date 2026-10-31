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
      }>(queries.listEvents, { filter: { conversationId }, first: 50, after });

      for (const event of response.events.nodes) {
        if (event.change?.id) messages.push(event.change as Message);
      }

      hasNextPage = response.events.pageInfo.hasNextPage;
      after = response.events.pageInfo.endCursor;
    }

    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return args.limit ? messages.slice(-args.limit) : messages;
  }

  async sendMessage(args: SendMessageArgs): Promise<Conversation> {
    const payload = await this.client.mutate<{ conversation: Conversation }>(
      mutations.conversationReply,
      'conversationReply',
      {
        conversationId: await this.client.resolveConversationId(args.conversationId),
        to: args.to,
        body: args.body,
      }
    );

    return payload.conversation;
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
