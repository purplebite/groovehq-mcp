import { GraphQLClient } from 'graphql-request';
import { GraphQLError } from './types/groove.js';
import { queries } from './utils/graphql-queries.js';

export class GrooveClient {
  private client: GraphQLClient;

  constructor(apiToken: string, apiUrl: string = 'https://api.groovehq.com/v2/graphql') {
    if (!apiToken) {
      throw new Error('Groove API token is required');
    }

    this.client = new GraphQLClient(apiUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async request<T = any>(query: string, variables?: any): Promise<T> {
    try {
      return await this.client.request<T>(query, variables);
    } catch (error: any) {
      if (error.response?.errors) {
        const graphqlError = error.response.errors[0] as GraphQLError;
        if (graphqlError.extensions?.code === 'RESOURCE_MERGED') {
          const target = String(graphqlError.extensions.new_conversation_id).replace(/^cnv_/, '#');
          throw new Error(`Ticket was merged into ${target}`);
        }
        // Groove reports an ID that never existed as deleted too
        if (graphqlError.message.includes('object of type Conversation is deleted')) {
          throw new Error('Ticket not found or deleted');
        }
        throw new Error(`GraphQL Error: ${graphqlError.message}`);
      }
      throw error;
    }
  }

  // Tickets are referred to by number; the API addresses them by conversation ID
  async resolveConversationId(ticket: string): Promise<string> {
    const number = ticket.trim().replace(/^#/, '');
    if (!/^\d+$/.test(number)) return ticket;

    const response = await this.request<{
      conversation: { id: string } | null;
    }>(queries.getConversationId, { number: Number(number) });

    if (!response.conversation) {
      // Groove finds no merged ticket by number, but its ID says where it went
      await this.request(queries.getTicketNode, { id: `cnv_${number}` });
      throw new Error(`Ticket not found: ${ticket}`);
    }

    return response.conversation.id;
  }

  // Mutations report validation failures in the payload instead of as GraphQL errors
  async mutate<T = any>(mutation: string, field: string, input: any): Promise<T> {
    const response = await this.request<
      Record<string, T & { errors?: Array<{ message: string }> }>
    >(mutation, { input });
    const payload = response[field];

    if (payload.errors?.length) {
      throw new Error(`Groove Error: ${payload.errors[0].message}`);
    }

    return payload;
  }

  async validateConnection(): Promise<boolean> {
    const query = `
      query ValidateConnection {
        me {
          id
          email
        }
      }
    `;

    try {
      await this.request(query);
      return true;
    } catch (error) {
      console.error('Failed to validate Groove connection:', error);
      return false;
    }
  }
}