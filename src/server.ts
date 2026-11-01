import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
import { FolderTools } from './tools/folders.js';
import { DraftTools } from './tools/drafts.js';
import { KnowledgeBaseResources } from './resources/kb-articles.js';

export { GrooveClient };

export interface GrooveServerOptions {
  token: string;
  apiUrl?: string;
  readOnly?: boolean;
  allowSend?: boolean;
  allowSendAs?: boolean;
  allowMerge?: boolean;
  allowPermanentDelete?: boolean;
}

const AUTHOR_SCHEMA = {
  type: 'string',
  description: 'ID of the agent to act as. Defaults to the agent who owns the API token',
};

const ATTACHMENTS_SCHEMA = {
  type: 'array',
  description: 'Files to attach, at most 25. Each has a fileName and either a url (https, up to 20 MB) or contentBase64 (up to 5 MB)',
  items: {
    type: 'object',
    properties: {
      fileName: { type: 'string', description: 'File name, with its extension' },
      url: { type: 'string', description: 'Public https link to the file' },
      contentBase64: { type: 'string', description: 'File content as base64. Use url for larger files' },
      contentType: { type: 'string', description: 'MIME type, for example application/pdf' },
    },
    required: ['fileName'],
  },
};

// claude.ai groups tools and sets approval by these. destructiveHint defaults to true, so always set it
const READ_TOOL = { readOnlyHint: true };
const ADDITIVE_TOOL = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE_TOOL = { readOnlyHint: false, destructiveHint: true };

const SEND_TOOLS = ['createConversation', 'sendMessage', 'forwardConversation', 'undoSend'];
const MERGE_TOOLS = ['mergeConversations', 'mergeContacts'];
const WRITE_TOOLS = [
  'logConversation',
  'deleteConversation',
  'deleteContact',
  'deleteContacts',
  'restoreConversation',
  'editNote',
  'reactToNote',
  'deleteNote',
  'updateConversation',
  'closeConversation',
  'createNote',
  'createContact',
  'updateCompany',
  'updateContact',
  'createReplyDraft',
  'deleteDraft',
];

export function createGrooveServer(opts: GrooveServerOptions): Server {
  if (!opts.token) {
    throw new Error('Groove API token is required');
  }

  const readOnly = opts.readOnly === true;
  const allowSend = opts.allowSend === true && !readOnly;
  const allowSendAs = opts.allowSendAs === true && !readOnly;
  const allowMerge = opts.allowMerge !== false && !readOnly;
  const allowPermanentDelete = opts.allowPermanentDelete === true && !readOnly;

  const authorField = allowSendAs ? { authorId: AUTHOR_SCHEMA } : {};

  function isEnabled(tool: string): boolean {
    if (SEND_TOOLS.includes(tool)) return allowSend;
    if (MERGE_TOOLS.includes(tool)) return allowMerge;
    if (WRITE_TOOLS.includes(tool)) return !readOnly;
    return true;
  }

  const grooveClient = new GrooveClient(opts.token, opts.apiUrl);
  const conversationTools = new ConversationTools(grooveClient);
  const messageTools = new MessageTools(grooveClient);
  const contactTools = new ContactTools(grooveClient);
  const agentTools = new AgentTools(grooveClient);
  const channelTools = new ChannelTools(grooveClient);
  const tagTools = new TagTools(grooveClient);
  const teamTools = new TeamTools(grooveClient);
  const folderTools = new FolderTools(grooveClient);
  const draftTools = new DraftTools(grooveClient);
  const kbResources = new KnowledgeBaseResources(grooveClient);

  const server = new Server(
    {
      name: 'groovehq-mcp',
      version: '0.9.0',
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
          annotations: READ_TOOL,
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
              folderId: {
                type: 'string',
                description: "Only tickets in this Smart Folder. Get the ID from listFolders. Don't combine it with channelId, unless that mailbox is listed for the folder.",
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
        },
        {
          name: 'createConversation',
          annotations: DESTRUCTIVE_TOOL,
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
              attachments: ATTACHMENTS_SCHEMA,
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
          },
        },
        {
          name: 'logConversation',
          annotations: ADDITIVE_TOOL,
          description:
            "Groove's Log a Conversation: creates a ticket for a contact that starts with an internal note, for example to record a phone call. Never sends email.",
          inputSchema: {
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
              attachments: ATTACHMENTS_SCHEMA,
              ...authorField,
            },
            required: ['channelId', 'to', 'subject', 'body'],
          },
        },
        {
          name: 'updateConversation',
          annotations: ADDITIVE_TOOL,
          description: 'Update a conversation (status, assignee, tags). Can also unassign and remove tags',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Ticket number (e.g. 12345) or conversation ID',
              },
              state: {
                type: 'string',
                enum: ['opened', 'closed', 'snoozed', 'unread', 'spam', 'trashed'],
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
                description: 'Move the ticket to this mailbox. Refused if this account has no access to it',
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
        },
        {
          name: 'deleteConversation',
          annotations: DESTRUCTIVE_TOOL,
          description:
            `Delete a ticket. It can be restored with restoreConversation${allowPermanentDelete ? ', unless permanent is set' : ''}. Always confirm with the user first.`,
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Ticket number (e.g. 12345) or conversation ID',
              },
              ...(allowPermanentDelete
                ? {
                    permanent: {
                      type: 'boolean',
                      description: 'Delete it for good. This cannot be undone. Only after the user agreed',
                      default: false,
                    },
                  }
                : {}),
            },
            required: ['id'],
          },
        },
        {
          name: 'restoreConversation',
          annotations: ADDITIVE_TOOL,
          description: 'Restore a ticket from spam, trash or deleted',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Ticket number (e.g. 12345) or conversation ID',
              },
              state: {
                type: 'string',
                enum: ['unread', 'opened', 'closed', 'spam'],
                description: 'State after restoring',
                default: 'opened',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'forwardConversation',
          annotations: DESTRUCTIVE_TOOL,
          description:
            'SENDS AN EMAIL IMMEDIATELY: forwards a ticket to the given addresses. The ticket keeps its state, and only gets a new subject if you pass one. Use only when the user explicitly asks.',
          inputSchema: {
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
              attachments: ATTACHMENTS_SCHEMA,
            },
            required: ['conversationId', 'to', 'body'],
          },
        },
        {
          name: 'undoSend',
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
        },
        {
          name: 'editNote',
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
        },
        {
          name: 'reactToNote',
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
        },
        {
          name: 'deleteNote',
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
        },
        {
          name: 'mergeConversations',
          annotations: DESTRUCTIVE_TOOL,
          description:
            'Permanently merge one ticket into another. This cannot be undone, so always confirm with the user first. ' +
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
        },
        {
          name: 'closeConversation',
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
        },
        {
          name: 'listMessages',
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
                description: 'Return only this many of the most recent messages (default: all)',
              },
            },
            required: ['conversationId'],
          },
        },
        {
          name: 'sendMessage',
          annotations: DESTRUCTIVE_TOOL,
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
              attachments: ATTACHMENTS_SCHEMA,
              ...authorField,
            },
            required: ['conversationId', 'to', 'body'],
          },
        },
        {
          name: 'createNote',
          annotations: ADDITIVE_TOOL,
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
              attachments: ATTACHMENTS_SCHEMA,
              ...authorField,
            },
            required: ['conversationId', 'body'],
          },
        },
        {
          name: 'listDrafts',
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
        },
        {
          name: 'createReplyDraft',
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
        },
        {
          name: 'deleteDraft',
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
        },
        {
          name: 'listContacts',
          annotations: READ_TOOL,
          description: 'List contacts with optional search, with their ticket counts. Returns one page; if pageInfo.hasNextPage is true, more results exist.',
          inputSchema: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Search string to filter contacts. Also finds part of a name or address',
              },
              email: {
                type: 'string',
                description: 'Find the contact with exactly this email address',
              },
              orderBy: {
                type: 'object',
                description: 'Sort order',
                properties: {
                  field: {
                    type: 'string',
                    enum: ['COMPANY_NAME', 'CONVERSATION_COUNT', 'CREATED_AT', 'EMAIL', 'JOB_TITLE', 'LAST_SEEN_AT', 'NAME', 'UPDATED_AT'],
                  },
                  direction: {
                    type: 'string',
                    enum: ['ASC', 'DESC'],
                    default: 'ASC',
                  },
                },
                required: ['field'],
              },
              orphansOnly: {
                type: 'boolean',
                description:
                  'Only contacts with 0 tickets. Reads at most 500 contacts per call, so call again with after for more. Never deletes anything. A contact can have 0 tickets and still have been CCed or have written mail in a merged ticket',
              },
              olderThanDays: {
                type: 'number',
                description: 'With orphansOnly: skip contacts created in the last N days',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of contacts per page. Groove returns at most 100. With orphansOnly it stops reading at this many, default 50, and can return slightly more',
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
          name: 'listCompanies',
          annotations: READ_TOOL,
          description: 'List companies with optional search. Returns one page; if pageInfo.hasNextPage is true, more results exist.',
          inputSchema: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Search string to filter companies',
              },
              orderBy: {
                type: 'object',
                description: 'Sort order. Use CONVERSATION_COUNT with DESC for the companies with the most tickets. Groove sorts counts only roughly, so sort the result again before showing a ranking',
                properties: {
                  field: {
                    type: 'string',
                    enum: ['CONTACT_COUNT', 'CONVERSATION_COUNT', 'CREATED_AT', 'DOMAIN', 'NAME', 'UPDATED_AT'],
                  },
                  direction: {
                    type: 'string',
                    enum: ['ASC', 'DESC'],
                    default: 'ASC',
                  },
                },
                required: ['field'],
              },
              limit: {
                type: 'number',
                description: 'Maximum number of companies to return per page',
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
          name: 'updateCompany',
          annotations: DESTRUCTIVE_TOOL,
          description: "Change a company's name or its extra domains. Groove often creates companies from mail domains, with no name or just the domain",
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The company ID',
              },
              name: {
                type: 'string',
                description: 'New name of the company',
              },
              addDomains: {
                type: 'array',
                items: { type: 'string' },
                description: 'Extra domains to add (existing domains are kept)',
              },
              removeDomains: {
                type: 'array',
                items: { type: 'string' },
                description: 'Extra domains to remove. The main domain cannot be removed',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'mergeContacts',
          annotations: DESTRUCTIVE_TOOL,
          description:
            'Permanently merge one contact into another, for example a typo address into the right one. This cannot be undone, so always confirm with the user first. ' +
            'The source contact and its address disappear. Its tickets move to the target, and its mail then shows the target as sender',
          inputSchema: {
            type: 'object',
            properties: {
              source: {
                type: 'string',
                description: 'Contact that disappears: exact email address or contact ID',
              },
              target: {
                type: 'string',
                description: 'Contact that stays: exact email address or contact ID',
              },
            },
            required: ['source', 'target'],
          },
        },
        {
          name: 'deleteContact',
          annotations: DESTRUCTIVE_TOOL,
          description:
            'Permanently delete one contact by exact email address, which also removes it from recipient suggestions. A contact with tickets cannot be deleted: use mergeContacts. ' +
            'Without confirm it only shows what would be deleted. Always show that to the user first. ' +
            'Mail this contact wrote in a merged ticket loses its sender',
          inputSchema: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                description: 'Exact email address of the contact',
              },
              confirm: {
                type: 'boolean',
                description: 'Really delete it. Only after the user agreed',
                default: false,
              },
            },
            required: ['email'],
          },
        },
        {
          name: 'deleteContacts',
          annotations: DESTRUCTIVE_TOOL,
          description:
            'Permanently delete up to 100 contacts by ID, one by one. A contact with tickets is skipped. ' +
            'Without confirm it only shows what would be deleted. Always show that to the user first. ' +
            'Mail these contacts wrote in merged tickets loses its sender',
          inputSchema: {
            type: 'object',
            properties: {
              contactIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Contact IDs to delete, at most 100',
              },
              confirm: {
                type: 'boolean',
                description: 'Really delete them. Only after the user agreed',
                default: false,
              },
            },
            required: ['contactIds'],
          },
        },
        {
          name: 'getContact',
          annotations: READ_TOOL,
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
          annotations: ADDITIVE_TOOL,
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
          annotations: DESTRUCTIVE_TOOL,
          description: 'Update contact information, companies and extra email addresses',
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
              companyIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Company IDs to add the contact to (existing companies are kept)',
              },
              removeCompanyIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Company IDs to remove the contact from',
              },
              addSecondaryEmails: {
                type: 'array',
                items: { type: 'string' },
                description: 'Extra email addresses to add to the contact (existing ones are kept)',
              },
              removeSecondaryEmails: {
                type: 'array',
                items: { type: 'string' },
                description: 'Extra email addresses to remove. Use email to change the main address',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'listAgents',
          annotations: READ_TOOL,
          description: 'List all agents in the organization',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'getAgent',
          annotations: READ_TOOL,
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
          annotations: READ_TOOL,
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
          annotations: READ_TOOL,
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
          annotations: READ_TOOL,
          description: 'List all teams, for filtering or assigning tickets',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'listFolders',
          annotations: READ_TOOL,
          description: 'List the Smart Folders this agent can open, in sidebar order, with their teams, agents, mailboxes, and the team they filter on. Names can repeat, so check these before you pick one.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'listChannels',
          annotations: READ_TOOL,
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
          annotations: READ_TOOL,
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
        const reason = readOnly
          ? 'GROOVE_READ_ONLY is on'
          : MERGE_TOOLS.includes(name)
            ? 'merging is turned off with GROOVE_ALLOW_MERGE=0'
            : 'it sends email, which needs GROOVE_ALLOW_SEND=1';
        throw new Error(`${name} is disabled: ${reason}`);
      }

      if (args?.authorId && !allowSendAs) {
        throw new Error('Acting as another agent is off: it needs GROOVE_ALLOW_SEND_AS=1');
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

        case 'logConversation': {
          if (!args || typeof args.channelId !== 'string' || typeof args.to !== 'string') {
            throw new Error('channelId, to, subject and body are required');
          }
          const result = await conversationTools.logConversation(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'deleteConversation': {
          if (!args || typeof args.id !== 'string') throw new Error('id is required');
          if (args.permanent && !allowPermanentDelete) {
            throw new Error('Permanent deletion is off: it needs GROOVE_ALLOW_PERMANENT_DELETE=1');
          }
          const result = await conversationTools.deleteConversation(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'restoreConversation': {
          if (!args || typeof args.id !== 'string') throw new Error('id is required');
          const result = await conversationTools.restoreConversation(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'forwardConversation': {
          if (!args || typeof args.conversationId !== 'string' || !Array.isArray(args.to) || typeof args.body !== 'string') {
            throw new Error('conversationId, to and body are required');
          }
          const result = await conversationTools.forwardConversation(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'undoSend': {
          if (!args || typeof args.conversationId !== 'string' || typeof args.changesetId !== 'string') {
            throw new Error('conversationId and changesetId are required');
          }
          const result = await messageTools.undoSend(args.conversationId, args.changesetId);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'editNote': {
          if (!args || typeof args.messageId !== 'string' || typeof args.body !== 'string') {
            throw new Error('messageId and body are required');
          }
          const result = await messageTools.editNote(args.messageId, args.body);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'reactToNote': {
          if (!args || typeof args.messageId !== 'string' || typeof args.reaction !== 'string') {
            throw new Error('messageId and reaction are required');
          }
          const result = await messageTools.reactToNote(args.messageId, args.reaction);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'deleteNote': {
          if (!args || typeof args.messageId !== 'string') throw new Error('messageId is required');
          const result = await messageTools.deleteNote(args.messageId);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

        case 'mergeConversations': {
          if (!args || typeof args.sourceId !== 'string' || typeof args.targetId !== 'string') {
            throw new Error('sourceId and targetId are required');
          }
          const result = await conversationTools.mergeConversations(args as any);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
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

        case 'listCompanies': {
          const result = await contactTools.listCompanies(args || {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'updateCompany': {
          if (!args || typeof args.id !== 'string') {
            throw new Error('id is required');
          }
          const company = await contactTools.updateCompany(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(company, null, 2) }] };
        }

        case 'mergeContacts': {
          if (!args || typeof args.source !== 'string' || typeof args.target !== 'string') {
            throw new Error('source and target are required');
          }
          const result = await contactTools.mergeContacts(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'deleteContact': {
          if (!args || typeof args.email !== 'string') {
            throw new Error('email is required');
          }
          const result = await contactTools.deleteContact(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'deleteContacts': {
          if (!args || !Array.isArray(args.contactIds)) {
            throw new Error('contactIds is required');
          }
          const result = await contactTools.deleteContacts(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

        case 'listFolders': {
          const folders = await folderTools.listFolders();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(folders, null, 2),
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

  return server;
}
