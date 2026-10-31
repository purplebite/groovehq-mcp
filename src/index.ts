#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GrooveClient } from './groove-client.js';
import { ConversationTools } from './tools/conversations.js';
import { MessageTools } from './tools/messages.js';
import { ContactTools } from './tools/contacts.js';
import { AgentTools } from './tools/agents.js';
import { ChannelTools } from './tools/channels.js';
import { TagTools } from './tools/tags.js';
import { TeamTools } from './tools/teams.js';
import { DraftTools } from './tools/drafts.js';
import { KnowledgeBaseResources } from './resources/kb-articles.js';

const apiToken = process.env.GROOVE_API_TOKEN;
const apiUrl = process.env.GROOVE_API_URL || 'https://api.groovehq.com/v2/graphql';

if (!apiToken) {
  console.error('Error: GROOVE_API_TOKEN environment variable is required');
  process.exit(1);
}

const readOnly = process.env.GROOVE_READ_ONLY === '1';
const allowSend = process.env.GROOVE_ALLOW_SEND === '1' && !readOnly;

const SEND_TOOLS = ['createConversation', 'sendMessage'];
const WRITE_TOOLS = [
  'updateConversation',
  'closeConversation',
  'createNote',
  'createContact',
  'updateContact',
  'createReplyDraft',
  'deleteDraft',
];

function isEnabled(tool: string): boolean {
  if (SEND_TOOLS.includes(tool)) return allowSend;
  if (WRITE_TOOLS.includes(tool)) return !readOnly;
  return true;
}

const grooveClient = new GrooveClient(apiToken, apiUrl);
const conversationTools = new ConversationTools(grooveClient);
const messageTools = new MessageTools(grooveClient);
const contactTools = new ContactTools(grooveClient);
const agentTools = new AgentTools(grooveClient);
const channelTools = new ChannelTools(grooveClient);
const tagTools = new TagTools(grooveClient);
const teamTools = new TeamTools(grooveClient);
const draftTools = new DraftTools(grooveClient);
const kbResources = new KnowledgeBaseResources(grooveClient);

const server = new Server(
  {
    name: 'groovehq-mcp',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'listConversations',
        description: 'List conversations with optional filters. Returns one page; if pageInfo.hasNextPage is true, more results exist.',
        inputSchema: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              enum: ['unread', 'opened', 'closed', 'snoozed'],
              description: 'Filter by conversation state. opened also includes unread, but leaves out snoozed: ask for snoozed separately to see every ticket that still needs work',
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
            channelId: {
              type: 'string',
              description: 'Filter by channel ID',
            },
            tagIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tag IDs',
            },
            keywords: {
              type: 'string',
              description: 'Full-text search across conversations',
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
      },
      {
        name: 'getConversation',
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
      },
      {
        name: 'createConversation',
        description: 'SENDS AN EMAIL IMMEDIATELY to the given address and creates a ticket. Use only when the user explicitly asks to send this message.',
        inputSchema: {
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
          },
          required: ['channelId', 'to', 'subject', 'body'],
        },
      },
      {
        name: 'updateConversation',
        description: 'Update a conversation (status, assignee, tags)',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ticket number (e.g. 12345) or conversation ID',
            },
            state: {
              type: 'string',
              enum: ['opened', 'closed', 'snoozed'],
              description: 'New conversation state',
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
              description: 'Tag IDs to add to the conversation (existing tags are kept)',
            },
            snoozedUntil: {
              type: 'string',
              description: 'ISO 8601 datetime to snooze until',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'closeConversation',
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
      },
      {
        name: 'listMessages',
        description: 'List messages and notes in a conversation, oldest first',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'Ticket number (e.g. 12345) or conversation ID',
            },
            limit: {
              type: 'number',
              description: 'Return only this many of the most recent messages (default: all)',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'sendMessage',
        description: 'SENDS AN EMAIL IMMEDIATELY as a reply on a ticket. Use only when the user explicitly asks to send this message; to prepare a reply for review, use createReplyDraft.',
        inputSchema: {
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
          },
          required: ['conversationId', 'to', 'body'],
        },
      },
      {
        name: 'createNote',
        description: 'Create an internal note in a conversation',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'Ticket number (e.g. 12345) or conversation ID',
            },
            body: {
              type: 'string',
              description: 'The note content',
            },
          },
          required: ['conversationId', 'body'],
        },
      },
      {
        name: 'listDrafts',
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
      },
      {
        name: 'createReplyDraft',
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
      },
      {
        name: 'deleteDraft',
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
      },
      {
        name: 'listContacts',
        description: 'List contacts with optional search. Returns one page; if pageInfo.hasNextPage is true, more results exist.',
        inputSchema: {
          type: 'object',
          properties: {
            search: {
              type: 'string',
              description: 'Search string to filter contacts',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of contacts to return per page',
              default: 20,
            },
            after: {
              type: 'string',
              description: 'Cursor for pagination',
            },
          },
        },
      },
      {
        name: 'getContact',
        description: 'Get detailed information about a specific contact',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The contact ID',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'createContact',
        description: 'Create a new contact',
        inputSchema: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              description: 'Contact email address',
            },
            firstName: {
              type: 'string',
              description: 'Contact first name',
            },
            lastName: {
              type: 'string',
              description: 'Contact last name',
            },
            title: {
              type: 'string',
              description: 'Contact job title',
            },
            phone: {
              type: 'string',
              description: 'Contact phone number',
            },
          },
          required: ['email'],
        },
      },
      {
        name: 'updateContact',
        description: 'Update contact information',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The contact ID',
            },
            email: {
              type: 'string',
              description: 'Contact email address',
            },
            firstName: {
              type: 'string',
              description: 'Contact first name',
            },
            lastName: {
              type: 'string',
              description: 'Contact last name',
            },
            title: {
              type: 'string',
              description: 'Contact job title',
            },
            phone: {
              type: 'string',
              description: 'Contact phone number',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'listAgents',
        description: 'List all agents in the organization',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getAgent',
        description: 'Get detailed information about a specific agent',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The agent ID',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'searchKbArticles',
        description: 'Search knowledge base articles',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of articles to return',
              default: 20,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'listTags',
        description: 'List all tags, for filtering or tagging tickets',
        inputSchema: {
          type: 'object',
          properties: {
            search: {
              type: 'string',
              description: 'Search string to filter tags by name',
            },
          },
        },
      },
      {
        name: 'listTeams',
        description: 'List all teams, for filtering or assigning tickets',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listChannels',
        description: 'List all available channels/inboxes',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of channels to return',
              default: 50,
            },
          },
        },
      },
      {
        name: 'getChannel',
        description: 'Get detailed information about a specific channel',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The channel ID',
            },
          },
          required: ['id'],
        },
      },
    ].filter(tool => isEnabled(tool.name)),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (!isEnabled(name)) {
      throw new Error(
        readOnly
          ? `${name} is disabled: GROOVE_READ_ONLY is on`
          : `${name} is disabled: it sends email, which needs GROOVE_ALLOW_SEND=1`
      );
    }

    switch (name) {
      case 'listConversations': {
        const conversations = await conversationTools.listConversations(args || {});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversations, null, 2),
            },
          ],
        };
      }

      case 'getConversation': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Conversation ID is required');
        }
        const conversation = await conversationTools.getConversation(args.id);
        if (!conversation) {
          throw new Error(`Conversation not found: ${args.id}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversation, null, 2),
            },
          ],
        };
      }

      case 'createConversation': {
        if (!args || !args.channelId || !args.to || !args.subject || !args.body) {
          throw new Error('channelId, to, subject, and body are required');
        }
        const conversation = await conversationTools.createConversation(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversation, null, 2),
            },
          ],
        };
      }

      case 'updateConversation': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Conversation ID is required');
        }
        const conversation = await conversationTools.updateConversation(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversation, null, 2),
            },
          ],
        };
      }

      case 'closeConversation': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Conversation ID is required');
        }
        const conversation = await conversationTools.closeConversation(args.id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversation, null, 2),
            },
          ],
        };
      }

      case 'listMessages': {
        if (!args || typeof args.conversationId !== 'string') {
          throw new Error('Conversation ID is required');
        }
        const messages = await messageTools.listMessages(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      }

      case 'sendMessage': {
        if (!args || !args.conversationId || !args.to || !args.body) {
          throw new Error('conversationId, to, and body are required');
        }
        const message = await messageTools.sendMessage(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(message, null, 2),
            },
          ],
        };
      }

      case 'createNote': {
        if (!args || !args.conversationId || !args.body) {
          throw new Error('conversationId and body are required');
        }
        const note = await messageTools.createNote(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(note, null, 2),
            },
          ],
        };
      }

      case 'listDrafts': {
        const drafts = await draftTools.listDrafts((args || {}) as { conversationId?: string });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(drafts, null, 2),
            },
          ],
        };
      }

      case 'createReplyDraft': {
        if (!args || typeof args.conversationId !== 'string' || typeof args.body !== 'string') {
          throw new Error('Conversation ID and body are required');
        }
        const draft = await draftTools.createReplyDraft(
          args as unknown as Parameters<DraftTools['createReplyDraft']>[0]
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(draft, null, 2),
            },
          ],
        };
      }

      case 'deleteDraft': {
        if (!args || typeof args.draftId !== 'string' || typeof args.conversationId !== 'string') {
          throw new Error('Draft ID and conversation ID are required');
        }
        const result = await draftTools.deleteDraft({
          draftId: args.draftId,
          conversationId: args.conversationId,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'listContacts': {
        const contacts = await contactTools.listContacts(args || {});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(contacts, null, 2),
            },
          ],
        };
      }

      case 'getContact': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Contact ID is required');
        }
        const contact = await contactTools.getContact(args.id);
        if (!contact) {
          throw new Error(`Contact not found: ${args.id}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(contact, null, 2),
            },
          ],
        };
      }

      case 'createContact': {
        if (!args || !args.email) {
          throw new Error('email is required');
        }
        const contact = await contactTools.createContact(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(contact, null, 2),
            },
          ],
        };
      }

      case 'updateContact': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Contact ID is required');
        }
        const contact = await contactTools.updateContact(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(contact, null, 2),
            },
          ],
        };
      }

      case 'listAgents': {
        const agents = await agentTools.listAgents();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(agents, null, 2),
            },
          ],
        };
      }

      case 'getAgent': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Agent ID is required');
        }
        const agent = await agentTools.getAgent(args.id);
        if (!agent) {
          throw new Error(`Agent not found: ${args.id}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(agent, null, 2),
            },
          ],
        };
      }

      case 'searchKbArticles': {
        if (!args || !args.query) {
          throw new Error('Search query is required');
        }
        const articles = await kbResources.searchArticles(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(articles, null, 2),
            },
          ],
        };
      }

      case 'listTags': {
        const tags = await tagTools.listTags(args || {});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tags, null, 2),
            },
          ],
        };
      }

      case 'listTeams': {
        const teams = await teamTools.listTeams();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(teams, null, 2),
            },
          ],
        };
      }

      case 'listChannels': {
        const channels = await channelTools.listChannels(args || {});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(channels, null, 2),
            },
          ],
        };
      }

      case 'getChannel': {
        if (!args || typeof args.id !== 'string') {
          throw new Error('Channel ID is required');
        }
        const channel = await channelTools.getChannel(args.id);
        if (!channel) {
          throw new Error(`Channel not found: ${args.id}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(channel, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    // Get published KB articles
    const articles = await kbResources.listArticles({ published: true, limit: 50 });
    const resources = articles.map(article => kbResources.formatArticleResource(article));
    
    return {
      resources,
    };
  } catch (error) {
    console.error('Error listing KB resources:', error);
    return {
      resources: [],
    };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  
  // Parse the URI to extract the type and ID
  const match = uri.match(/^groove:\/\/kb\/(article|category)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  
  const [, type, id] = match;
  
  if (type === 'article') {
    const article = await kbResources.getArticle(id);
    if (!article) {
      throw new Error(`Knowledge base article not found: ${id}`);
    }
    
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: `# ${article.title}\n\n${article.body}`,
          metadata: {
            category: article.category?.title,
            state: article.state,
            featured: article.featured,
            createdAt: article.createdAt,
            updatedAt: article.updatedAt,
          },
        },
      ],
    };
  }
  
  throw new Error(`Unsupported resource type: ${type}`);
});

async function main() {
  console.error('Validating Groove API connection...');
  const isValid = await grooveClient.validateConnection();
  
  if (!isValid) {
    console.error('Failed to connect to Groove API. Please check your API token.');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Groove MCP server started successfully');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});