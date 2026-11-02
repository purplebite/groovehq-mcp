import type { ConversationTools } from './conversations.js';
import type { MessageTools } from './messages.js';
import type { ContactTools } from './contacts.js';
import type { AgentTools } from './agents.js';
import type { ChannelTools } from './channels.js';
import type { TagTools } from './tags.js';
import type { TeamTools } from './teams.js';
import type { FolderTools } from './folders.js';
import type { DraftTools } from './drafts.js';
import type { KnowledgeBaseResources } from '../resources/kb-articles.js';

// claude.ai groups tools and sets approval by these. destructiveHint defaults to true, so always set it
export const READ_TOOL = { readOnlyHint: true };
export const ADDITIVE_TOOL = { readOnlyHint: false, destructiveHint: false };
export const DESTRUCTIVE_TOOL = { readOnlyHint: false, destructiveHint: true };

export const AUTHOR_SCHEMA = {
  type: 'string',
  description: 'ID of the agent to act as. Defaults to the agent who owns the API token',
};

export const ATTACHMENTS_SCHEMA = {
  type: 'array',
  description: 'Files to attach, at most 25, up to 20 MB each. Each has a fileName and either a url (https) or contentBase64. Use url for anything but small files',
  items: {
    type: 'object',
    properties: {
      fileName: { type: 'string', description: 'File name, with its extension' },
      url: { type: 'string', description: 'Public https link to the file' },
      contentBase64: { type: 'string', description: 'File content as base64' },
      contentType: { type: 'string', description: 'MIME type, for example application/pdf' },
    },
    required: ['fileName'],
  },
};

/**
 * The setting a tool needs:
 * read always runs, write needs GROOVE_READ_ONLY off, send needs GROOVE_ALLOW_SEND,
 * merge needs GROOVE_ALLOW_MERGE, permanentDelete needs GROOVE_ALLOW_PERMANENT_DELETE
 */
export type Setting = 'read' | 'write' | 'send' | 'merge' | 'permanentDelete';

export interface PropertySchema {
  type?: string;
  items?: { type?: string };
  [key: string]: unknown;
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
}

// Present only when the matching setting is on, so a model never sees a field it can't use
export interface OptionalFields {
  authorField: { authorId?: typeof AUTHOR_SCHEMA };
  attachmentsField: { attachments?: typeof ATTACHMENTS_SCHEMA };
}

export interface ToolContext {
  conversations: ConversationTools;
  messages: MessageTools;
  contacts: ContactTools;
  agents: AgentTools;
  channels: ChannelTools;
  tags: TagTools;
  teams: TeamTools;
  folders: FolderTools;
  drafts: DraftTools;
  kb: KnowledgeBaseResources;
}

export interface ToolDefinition<Args> {
  name: string;
  setting: Setting;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  description: string;
  inputSchema: InputSchema | ((fields: OptionalFields) => InputSchema);
  handler: (args: Args, context: ToolContext) => Promise<unknown>;
}

// The server checks every argument against the schema before a handler runs, so the arguments match Args
export type Tool = ToolDefinition<Record<string, unknown>>;

export function defineTool<Args>(definition: ToolDefinition<Args>): Tool {
  return definition as unknown as Tool;
}
