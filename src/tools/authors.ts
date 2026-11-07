import { GrooveClient } from '../groove-client.js';
import { Conversation } from '../types/groove.js';
import { pageGuard } from '../utils/paging.js';
import { ConversationTools, listConversations } from './conversations.js';
import { defineTool, InputSchema, READ_TOOL } from './definition.js';

// Groove has no filter on who wrote in a ticket, so this reads the authors of the messages itself.
// 40 tickets with 30 messages each stayed under Groove's complexity limit of 400 in one request (measured)
const TICKETS_PER_REQUEST = 40;
const MESSAGES_PER_PAGE = 30;
// Up to this many tickets are read without asking; above it the call needs confirm
const READ_FREELY = 1000;
// The ticket list stops after 100 pages of 50 anyway (pageGuard)
const MOST = 5000;
const TICKETS_PER_PAGE = 50;

interface AuthorsArgs {
  agentId?: string;
  writtenAfter?: string;
  writtenBefore?: string;
  confirm?: boolean;
  [filter: string]: unknown;
}

interface MessageNode {
  change: { id?: string; isNote?: boolean; createdAt?: string; author?: { id?: string; name?: string } | null } | null;
}

interface EventsPage {
  nodes: MessageNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface AgentTotals {
  id: string;
  name: string;
  tickets: number;
  replies: number;
  notes: number;
  first: string;
  last: string;
}

interface TicketRow {
  number: number;
  subject: string;
  replies: number;
  notes: number;
  first: string;
  last: string;
}

const AUTHOR_PAGE = `
  nodes {
    change {
      ... on Message {
        id
        isNote
        createdAt
        author {
          ... on Agent {
            id
            name
          }
        }
      }
    }
  }
  pageInfo {
    hasNextPage
    endCursor
  }
`;

function batchQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, index) => `$c${index}: ID!`).join(', ');
  const fields = Array.from({ length: count }, (_, index) =>
    `e${index}: events(filter: { conversationId: $c${index}, eventType: [MESSAGE_CREATED] }, first: ${MESSAGES_PER_PAGE}) { ${AUTHOR_PAGE} }`
  ).join('\n');
  return `query ListAuthors(${variables}) { ${fields} }`;
}

const PAGE_QUERY = `
  query ListAuthorsPage($conversationId: ID!, $after: String) {
    events(filter: { conversationId: $conversationId, eventType: [MESSAGE_CREATED] }, first: ${MESSAGES_PER_PAGE}, after: $after) { ${AUTHOR_PAGE} }
  }
`;

function toTime(key: string, value: string): number {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new Error(`${key} must be a date, like 2026-10-01 or 2026-10-01T09:00:00Z`);
  return time;
}

// Groove's own answers about a ticket come as GraphQL errors, some reworded by the client; anything else means the request itself failed
const GROOVE_SAID = ['GraphQL Error', 'Ticket was merged into', 'Ticket not found or deleted', 'Groove refused the request (HTTP 403)'];
const isGraphqlError = (error: unknown) => error instanceof Error && GROOVE_SAID.some(start => error.message.startsWith(start));

export class AuthorTools {
  private conversations: ConversationTools;

  constructor(private client: GrooveClient) {
    this.conversations = new ConversationTools(client);
  }

  async listConversationAuthors(args: AuthorsArgs) {
    const { agentId, writtenAfter, writtenBefore, confirm, ...filters } = args;
    const after = writtenAfter ? toTime('writtenAfter', writtenAfter) : undefined;
    const before = writtenBefore ? toTime('writtenBefore', writtenBefore) : undefined;
    let requests = 0;

    // One request says how many tickets match, so a big scan is a choice and not a surprise
    const count = await this.conversations.listConversations({ ...filters, limit: 1 });
    requests++;
    const matched = count.totalCount;
    if (count.totalCountCapped || matched > MOST) {
      throw new Error(`${count.totalCountCapped ? 'More than ' : ''}${matched} tickets match, more than the ${MOST} this tool can read. Narrow the filter, for example to one mailbox or a shorter period`);
    }
    if (matched > READ_FREELY && confirm !== true) {
      return {
        matched,
        read: 0,
        requests,
        needsConfirm: true,
        message: `${matched} tickets match, more than the ${READ_FREELY} read without asking. Reading them takes about ${Math.ceil(matched / TICKETS_PER_PAGE) + Math.ceil(matched / TICKETS_PER_REQUEST)} requests. Ask the user whether that is okay, and call again with confirm: true, or narrow the filter`,
      };
    }

    // All matching tickets, 50 per page
    const tickets: Conversation[] = [];
    const listed = new Set<string>();
    const nextPage = pageGuard('tickets');
    let cursor: string | undefined;
    while (tickets.length < matched) {
      requests++;
      const page = await this.conversations.listConversations({ ...filters, limit: TICKETS_PER_PAGE, after: cursor });
      // A ticket updated during the read can shift to a later page and come by twice
      for (const ticket of page.conversations) {
        if (!listed.has(ticket.id)) tickets.push(ticket);
        listed.add(ticket.id);
      }
      if (!page.conversations.length) break;
      if (!page.pageInfo.hasNextPage) break;
      cursor = nextPage(page.pageInfo.endCursor ?? null);
    }

    const byAgent = new Map<string, AgentTotals & { ticketIds: Set<string> }>();
    const rows: TicketRow[] = [];
    const failed: number[] = [];
    let ticketsWithAgent = 0;

    const tally = (ticket: Conversation, messages: MessageNode[]) => {
      let replies = 0;
      let notes = 0;
      let first = '';
      let last = '';
      const seen = new Set<string>();
      for (const { change } of messages) {
        const author = change?.author;
        if (!change?.id || !author?.id || !change.createdAt) continue;
        const written = new Date(change.createdAt).getTime();
        if (after !== undefined && written < after) continue;
        if (before !== undefined && written >= before) continue;
        if (agentId && author.id !== agentId) continue;
        const totals = byAgent.get(author.id) ?? {
          id: author.id, name: author.name ?? '', tickets: 0, replies: 0, notes: 0, first: change.createdAt, last: change.createdAt, ticketIds: new Set<string>(),
        };
        totals.ticketIds.add(ticket.id);
        if (change.isNote) totals.notes++; else totals.replies++;
        if (change.createdAt < totals.first) totals.first = change.createdAt;
        if (change.createdAt > totals.last) totals.last = change.createdAt;
        byAgent.set(author.id, totals);
        seen.add(author.id);
        if (change.isNote) notes++; else replies++;
        if (!first || change.createdAt < first) first = change.createdAt;
        if (!last || change.createdAt > last) last = change.createdAt;
      }
      if (seen.size) ticketsWithAgent++;
      if (agentId && seen.size) rows.push({ number: ticket.number, subject: ticket.subject ?? '', replies, notes, first, last });
    };

    // The rest of a ticket's messages, for the few tickets with more than one page
    const restOf = async (ticket: Conversation, page: EventsPage): Promise<MessageNode[]> => {
      const nodes = [...page.nodes];
      const nextMessages = pageGuard('messages');
      let current = page;
      while (current.pageInfo.hasNextPage) {
        const cursorAfter = nextMessages(current.pageInfo.endCursor ?? null);
        requests++;
        const response = await this.client.request<{ events: EventsPage }>(PAGE_QUERY, { conversationId: ticket.id, after: cursorAfter });
        current = response.events;
        nodes.push(...current.nodes);
      }
      return nodes;
    };

    // One request per 40 tickets. When Groove refuses a batch, it is split, so one broken ticket is reported
    // and not the whole batch. A failed request (network, 5xx, token) stops the whole call instead
    const read = async (batch: Conversation[]): Promise<void> => {
      // Nothing is counted until every ticket of the batch is in, so a retry after a failure counts nothing twice
      const messages: Array<[Conversation, MessageNode[] | null]> = [];
      try {
        const variables = Object.fromEntries(batch.map((ticket, index) => [`c${index}`, ticket.id]));
        requests++;
        const response = await this.client.request<Record<string, EventsPage | null>>(batchQuery(batch.length), variables);
        for (const [index, ticket] of batch.entries()) {
          const page = response[`e${index}`];
          messages.push([ticket, page ? (page.pageInfo.hasNextPage ? await restOf(ticket, page) : page.nodes) : null]);
        }
      } catch (error) {
        if (!isGraphqlError(error)) throw error;
        if (batch.length === 1) {
          failed.push(batch[0].number);
          return;
        }
        const half = Math.ceil(batch.length / 2);
        await read(batch.slice(0, half));
        await read(batch.slice(half));
        return;
      }
      for (const [ticket, nodes] of messages) {
        if (nodes) tally(ticket, nodes); else failed.push(ticket.number);
      }
    };

    for (let start = 0; start < tickets.length; start += TICKETS_PER_REQUEST) {
      await read(tickets.slice(start, start + TICKETS_PER_REQUEST));
    }

    const agents = [...byAgent.values()]
      .map(({ ticketIds, ...totals }) => ({ ...totals, tickets: ticketIds.size }))
      .sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name));
    rows.sort((a, b) => b.last.localeCompare(a.last));

    return {
      matched,
      read: tickets.length,
      ticketsWithAgentMessages: ticketsWithAgent,
      requests,
      ...(failed.length ? { failed } : {}),
      agents,
      ...(agentId ? { tickets: rows } : {}),
    };
  }
}

// The same filters as listConversations, without paging and order: this tool reads every matching ticket
const FILTERS = Object.fromEntries(
  Object.entries((listConversations.inputSchema as InputSchema).properties).filter(([key]) => !['limit', 'after', 'orderBy'].includes(key))
);

export const listConversationAuthors = defineTool<AuthorsArgs>({
  name: 'listConversationAuthors',
  setting: 'read',
  annotations: READ_TOOL,
  description:
    'Who replied or left a note in which tickets. Groove cannot filter on this, so the tool reads the messages of every matching ticket itself, 40 tickets per request, and returns totals per agent: tickets, replies, notes, first and last message. ' +
    'With agentId it also lists that agent\'s tickets. Use this instead of calling listMessages per ticket. ' +
    `It takes the filters of listConversations, plus writtenAfter and writtenBefore for the messages themselves. Up to ${READ_FREELY} matching tickets are read without asking; above that it stops and needs confirm: true`,
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Only count this agent, and list the tickets they wrote in',
      },
      writtenAfter: {
        type: 'string',
        description: 'Only messages written on or after this date (a date alone means midnight UTC). Combine with updatedAfter so the ticket list stays small',
      },
      writtenBefore: {
        type: 'string',
        description: 'Only messages written before this date. A date alone means midnight UTC at its start, so for a whole month give the first day of the next one',
      },
      ...FILTERS,
      confirm: {
        type: 'boolean',
        description: `Read more than ${READ_FREELY} tickets. Only after the user agreed to the number of requests`,
        default: false,
      },
    },
  },
  handler: (args, { authors }) => authors.listConversationAuthors(args),
});
