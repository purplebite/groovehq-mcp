import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GrooveClient } from './groove-client.js';
import * as conversations from './tools/conversations.js';
import * as messages from './tools/messages.js';
import * as contacts from './tools/contacts.js';
import * as agents from './tools/agents.js';
import * as channels from './tools/channels.js';
import * as tags from './tools/tags.js';
import * as teams from './tools/teams.js';
import * as folders from './tools/folders.js';
import * as drafts from './tools/drafts.js';
import * as attachmentReader from './tools/attachment-reader/index.js';
import * as cannedReplies from './tools/canned-replies.js';
import * as rules from './tools/rules.js';
import * as kb from './resources/kb-articles.js';
import {
  ATTACHMENTS_SCHEMA,
  AUTHOR_SCHEMA,
  InputSchema,
  isMcpContent,
  OptionalFields,
  PropertySchema,
  Tool,
  ToolContext,
} from './tools/definition.js';

export { GrooveClient };

export interface GrooveServerOptions {
  token: string;
  apiUrl?: string;
  readOnly?: boolean;
  allowSend?: boolean;
  allowSendAs?: boolean;
  allowMerge?: boolean;
  allowPermanentDelete?: boolean;
  allowAttachments?: boolean;
  readAttachments?: boolean;
}

const BOOLEAN_OPTIONS = ['readOnly', 'allowSend', 'allowSendAs', 'allowMerge', 'allowPermanentDelete', 'allowAttachments', 'readAttachments'] as const;

// tools/list returns them in this order
const TOOLS: Tool[] = [
  conversations.listConversations,
  conversations.getConversation,
  conversations.listLinkedResources,
  conversations.createConversation,
  conversations.logConversation,
  conversations.updateConversation,
  conversations.linkResource,
  conversations.deleteConversation,
  conversations.deleteConversationPermanently,
  conversations.restoreConversation,
  conversations.markAsSpam,
  conversations.forwardConversation,
  messages.undoSend,
  messages.moveMessageToNewTicket,
  messages.editNote,
  messages.reactToNote,
  messages.deleteNote,
  conversations.mergeConversations,
  conversations.closeConversation,
  messages.listMessages,
  messages.getRawEmail,
  attachmentReader.getAttachment,
  messages.sendMessage,
  messages.createNote,
  drafts.listDrafts,
  drafts.createReplyDraft,
  drafts.deleteDraft,
  cannedReplies.listCannedReplies,
  contacts.listContacts,
  contacts.listCompanies,
  contacts.updateCompany,
  contacts.mergeContacts,
  contacts.deleteContact,
  contacts.getContact,
  contacts.getContactProfile,
  contacts.createContact,
  contacts.updateContact,
  agents.listAgents,
  agents.getAgent,
  kb.searchKbArticles,
  tags.listTags,
  teams.listTeams,
  folders.listFolders,
  rules.listRules,
  channels.listChannels,
  channels.getChannel,
];

function checkArgument(key: string, field: PropertySchema, value: unknown): void {
  if (value === undefined) return;
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
    return;
  }
  if (value === null) return;

  if (key === 'limit') {
    if (!Number.isInteger(value) || (value as number) < 1) throw new Error('limit must be a whole number of at least 1');
  } else if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  } else if (field.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${key} must be text`);
  } else if (field.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${key} must be a list`);
    if (field.items?.type === 'string' && value.some(item => typeof item !== 'string')) {
      throw new Error(`${key} must be a list of text`);
    }
  }
}

// Left out, null and empty text all count as missing
function checkRequired(schema: InputSchema, args: Record<string, unknown>): void {
  const required = schema.required ?? [];
  if (!required.some(key => args[key] == null || args[key] === '')) return;

  const names = required.length > 1 ? `${required.slice(0, -1).join(', ')} and ${required.at(-1)}` : required[0];
  throw new Error(`${names} ${required.length > 1 ? 'are' : 'is'} required`);
}

export function createGrooveServer(opts: GrooveServerOptions): Server {
  if (!opts.token) {
    throw new Error('Groove API token is required');
  }

  // A string like 'true' would otherwise leave a safety setting silently off
  for (const name of BOOLEAN_OPTIONS) {
    const value = opts[name];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${name} must be true or false`);
    }
  }

  const readOnly = opts.readOnly === true;
  const allowSend = opts.allowSend === true && !readOnly;
  const allowSendAs = opts.allowSendAs === true && !readOnly;
  const allowMerge = opts.allowMerge !== false && !readOnly;
  const allowPermanentDelete = opts.allowPermanentDelete === true && !readOnly;
  const allowAttachments = opts.allowAttachments === true && !readOnly;
  // Reading only, so read-only mode leaves it on
  const readAttachments = opts.readAttachments !== false;

  const fields: OptionalFields = {
    authorField: allowSendAs ? { authorId: AUTHOR_SCHEMA } : {},
    attachmentsField: allowAttachments ? { attachments: ATTACHMENTS_SCHEMA } : {},
  };

  function isEnabled(tool: Tool | undefined): boolean {
    switch (tool?.setting) {
      case 'send':
        return allowSend;
      case 'merge':
        return allowMerge;
      case 'permanentDelete':
        return allowPermanentDelete;
      case 'write':
        return !readOnly;
      case 'readAttachments':
        return readAttachments;
      default:
        return true;
    }
  }

  const grooveClient = new GrooveClient(opts.token, opts.apiUrl);
  const kbResources = new kb.KnowledgeBaseResources(grooveClient);
  const context: ToolContext = {
    conversations: new conversations.ConversationTools(grooveClient),
    messages: new messages.MessageTools(grooveClient),
    contacts: new contacts.ContactTools(grooveClient),
    agents: new agents.AgentTools(grooveClient),
    channels: new channels.ChannelTools(grooveClient),
    tags: new tags.TagTools(grooveClient),
    teams: new teams.TeamTools(grooveClient),
    folders: new folders.FolderTools(grooveClient),
    drafts: new drafts.DraftTools(grooveClient),
    kb: kbResources,
    attachmentReader: new attachmentReader.AttachmentReader(),
    cannedReplies: new cannedReplies.CannedReplyTools(grooveClient),
    rules: new rules.RuleTools(grooveClient),
  };

  const server = new Server(
    {
      name: 'groovehq-mcp',
      version: '0.16.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  const schemaOf = (tool: Tool): InputSchema =>
    typeof tool.inputSchema === 'function' ? tool.inputSchema(fields) : tool.inputSchema;

  const tools = TOOLS.filter(isEnabled).map(tool => ({
    name: tool.name,
    annotations: tool.annotations,
    description: tool.description,
    inputSchema: schemaOf(tool),
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = TOOLS.find(definition => definition.name === name);

    try {
      if (!isEnabled(tool)) {
        const reason = tool?.setting === 'readAttachments'
          ? 'reading attachments is turned off with GROOVE_READ_ATTACHMENTS=0'
          : readOnly
            ? 'GROOVE_READ_ONLY is on'
            : tool?.setting === 'merge'
              ? 'merging is turned off with GROOVE_ALLOW_MERGE=0'
              : tool?.setting === 'permanentDelete'
                ? 'it needs GROOVE_ALLOW_PERMANENT_DELETE=1'
                : 'it sends email, which needs GROOVE_ALLOW_SEND=1';
        throw new Error(`${name} is disabled: ${reason}`);
      }

      if (args.authorId != null && !allowSendAs) {
        throw new Error('Acting as another agent is off: it needs GROOVE_ALLOW_SEND_AS=1');
      }

      // The server gets every call as is, so the schema of a tool isn't enforced by anything else
      const schema = tools.find(listed => listed.name === name)?.inputSchema;
      for (const [key, field] of Object.entries(schema?.properties ?? {})) {
        checkArgument(key, field, args[key]);
      }

      // Refused rather than ignored, so a mail never goes out without its file
      if (!allowAttachments && (args.attachments as unknown[] | undefined)?.length) {
        throw new Error('Attachments are off: they need GROOVE_ALLOW_ATTACHMENTS=1');
      }

      if (!tool || !schema) throw new Error(`Unknown tool: ${name}`);
      checkRequired(schema, args);

      const result = await tool.handler(args, context);
      if (isMcpContent(result)) return { content: result.content };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }, null, 2),
          },
        ],
        isError: true,
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
      // Drafts and deleted articles stay hidden, like in the resource list
      if (!article || !kb.LIVE_STATES.includes(article.state)) {
        throw new Error(`Knowledge base article not found: ${id}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: `# ${article.title}\n\n${article.body}`,
            // MCP clients drop fields outside the spec, so extra data goes in _meta
            _meta: {
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

  return server;
}
