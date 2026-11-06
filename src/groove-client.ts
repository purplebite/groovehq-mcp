import { GraphQLClient, Variables } from 'graphql-request';
import { GraphQLError } from './types/groove.js';
import { queries } from './utils/graphql-queries.js';

export class GrooveClient {
  private client: GraphQLClient;
  private apiToken: string;

  constructor(apiToken: string, apiUrl: string = 'https://api.groovehq.com/v2/graphql') {
    if (!apiToken) {
      throw new Error('Groove API token is required');
    }

    this.apiToken = apiToken;
    this.client = new GraphQLClient(apiUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private redact(message: string): string {
    return message.split(this.apiToken).join('[token]');
  }

  async request<T = unknown>(query: string, variables?: Variables): Promise<T> {
    try {
      return await this.client.request<T>(query, variables);
    } catch (error) {
      const { response } = error as { response?: { errors?: GraphQLError[]; status?: number } };
      // Before the GraphQL errors, because Groove can send those with a 401 too
      if (response?.status === 401) {
        throw new Error('Groove refused the API token (HTTP 401). Check GROOVE_API_TOKEN');
      }
      // A 403 can be about one mailbox or ticket, so Groove's own message says more than a token hint
      if (response?.status === 403) {
        const detail = response.errors?.[0]?.message;
        throw new Error(
          detail
            ? `Groove refused the request (HTTP 403): ${this.redact(detail)}`
            : 'Groove refused the request (HTTP 403). Check GROOVE_API_TOKEN and what it may access',
        );
      }
      if (response?.errors) {
        const graphqlError = response.errors[0];
        if (graphqlError.extensions?.code === 'RESOURCE_MERGED') {
          const target = String(graphqlError.extensions.new_conversation_id).replace(/^cnv_/, '#');
          throw new Error(`Ticket was merged into ${target}`);
        }
        // Groove reports an ID that never existed as deleted too
        if (graphqlError.message.includes('object of type Conversation is deleted')) {
          throw new Error('Ticket not found or deleted');
        }
        throw new Error(`GraphQL Error: ${this.redact(graphqlError.message)}`);
      }
      // The original error holds the whole query, its variables and the response
      if (response?.status) {
        throw new Error(`Groove API error: HTTP ${response.status}`);
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
  async mutate<T = unknown>(mutation: string, field: string, input: Variables): Promise<T> {
    const response = await this.request<
      Record<string, T & { errors?: Array<{ message: string }> }>
    >(mutation, { input });
    const payload = response[field];

    if (payload.errors?.length) {
      throw new Error(`Groove Error: ${this.redact(payload.errors[0].message)}`);
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
    } catch {
      return false;
    }
  }
}