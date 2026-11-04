export interface Channel {
  __typename: string;
  id: string;
  name: string;
  type: 'EMAIL' | 'TWITTER' | 'FACEBOOK' | 'WIDGET' | 'API' | 'CHAT' | 'FORWARDING';
  conversationCount: number;
  color: string;
  state: 'ACTIVE' | 'INACTIVE' | 'DELETED';
  senderName?: string;
  email?: string;
  fromName?: string;
  useAgentName?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  number: number;
  state: 'UNREAD' | 'OPENED' | 'CLOSED' | 'SNOOZED' | 'DELETED' | 'SPAM' | 'TRASH';
  subject?: string;
  createdAt: string;
  updatedAt: string;
  stateUpdatedAt?: string;
  assigned?: {
    agent?: Agent;
    team?: Team;
    at?: string;
  };
  contact?: Contact;
  counts: {
    messages: number;
    notes: number;
    interactions: number;
    attachments: number;
    stateChanges: number;
  };
  tags: {
    nodes: Tag[];
  };
  snoozed?: {
    by?: {
      id: string;
      email: string;
    };
    until?: string;
  };
  starred: boolean;
  channel?: Channel;
}

export interface Message {
  id: string;
  author: Contact | Agent;
  body: string;
  bodyPlainText?: string;
  createdAt: string;
  updatedAt: string;
  isNote: boolean;
  attachments: {
    nodes: Attachment[];
  };
}

export interface Contact {
  id: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  contactType?: string;
  conversationCount?: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string | null;
  secondaryEmails?: string[];
  companies?: {
    nodes: Array<{
      id: string;
      name: string;
    }>;
  };
}

export interface Agent {
  id: string;
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  role: 'admin' | 'agent';
  state: string;
  username?: string | null;
  teams?: Array<{ id: string; name: string }>;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  members?: Array<{ id: string; name: string; email: string }>;
}

export interface FolderOwner {
  id: string;
  name: string;
}

export interface Folder {
  id: string;
  name: string;
  teams: FolderOwner[];
  agents: FolderOwner[];
  channels: FolderOwner[] | 'all';
  assignedTeam: FolderOwner | null;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  conversationCount?: number;
}

export interface Attachment {
  id: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
  url?: string;
  downloadUrl?: string;
}

export interface KnowledgeBaseArticle {
  id: string;
  title: string;
  slug: string;
  description?: string;
  body: string;
  state: string;
  featured: boolean;
  url?: string;
  category?: KnowledgeBaseCategory;
  author?: Agent;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  // The version on the help site; title, description and body can hold unpublished changes
  currentVersion?: { title: string; description?: string; body: string } | null;
}

export interface KnowledgeBaseCategory {
  id: string;
  title: string;
  slug: string;
}

export interface GraphQLError {
  message: string;
  extensions?: {
    code: string;
    [key: string]: unknown;
  };
}

export interface Draft {
  __typename: string;
  id: string;
  draftId: string;
  draftType: 'REPLY' | 'REPLY_ALL' | 'NOTE';
  conversationId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; email: string };
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: string | null;
  body?: string;
}
