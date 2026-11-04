import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Contact } from '../types/groove.js';
import { defineTool, ADDITIVE_TOOL, DESTRUCTIVE_TOOL, READ_TOOL } from './definition.js';

interface ListContactsArgs {
  search?: string;
  email?: string;
  orderBy?: {
    field: string;
    direction?: 'ASC' | 'DESC';
  };
  orphansOnly?: boolean;
  olderThanDays?: number;
  limit?: number;
  after?: string;
}

interface ListContactsResult {
  contacts: Contact[];
  totalCount: number;
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  contactsRead?: number;
  note?: string;
}

interface CreateContactArgs {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  phone?: string;
}

interface UpdateContactArgs {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  phone?: string;
  companyIds?: string[];
  removeCompanyIds?: string[];
  addSecondaryEmails?: string[];
  removeSecondaryEmails?: string[];
}

interface UpdateCompanyArgs {
  id: string;
  name?: string;
  addDomains?: string[];
  removeDomains?: string[];
}

interface ListCompaniesArgs {
  search?: string;
  orderBy?: {
    field: string;
    direction?: 'ASC' | 'DESC';
  };
  limit?: number;
  after?: string;
}

interface Company {
  id: string;
  name: string | null;
  domain: string | null;
  conversationCount?: number;
}

interface MergeContactsArgs {
  source: string;
  target: string;
}

interface DeleteContactArgs {
  email: string;
  confirm?: boolean;
}

interface DeleteContactsArgs {
  contactIds: string[];
  confirm?: boolean;
}

type DeleteOutcome =
  | { id: string; status: 'would delete' | 'deleted'; email?: string; name?: string }
  | { id: string; status: 'skipped' | 'failed'; email?: string; reason: string };

const MAX_BULK_DELETE = 100;
const ORPHAN_PAGE_SIZE = 100;
const MAX_ORPHAN_PAGES = 5;
const BULK_DELETE_PAUSE_MS = 100;
const RATE_LIMIT_RETRIES = 3;

const SENDER_WARNING =
  'Mail this contact wrote in a merged ticket loses its sender when the contact is deleted. Groove cannot show which contacts this affects.';

const EMAIL_PATTERN = /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/;
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CUSTOM_FIELD_KEYS = {
  email: 'contact_email',
  firstName: 'contact_first_name',
  lastName: 'contact_last_name',
  title: 'contact_job_title',
  phone: 'contact_phone_number',
} as const;

// Groove stores contact details as custom fields rather than contact attributes
function toCustomFields(args: Partial<Record<keyof typeof CUSTOM_FIELD_KEYS, string>>) {
  const fields = [];

  for (const [name, key] of Object.entries(CUSTOM_FIELD_KEYS)) {
    const value = args[name as keyof typeof CUSTOM_FIELD_KEYS];
    if (value !== undefined) fields.push({ customFieldIdOrKey: key, value });
  }

  return fields;
}

// The custom profile is HTML for Groove's sidebar; a model reads it better as plain lines
export function profileText(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|ul|ol|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    })
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line && line !== '-')
    .join('\n');
}

export class ContactTools {
  constructor(private client: GrooveClient) {}

  async getContactProfile(args: { contactId: string; channelId?: string; refresh?: boolean }) {
    const response = await this.client.request<{ customProfile: unknown }>(queries.getCustomProfile, {
      contactId: args.contactId,
      channelId: args.channelId,
      hardRefresh: args.refresh,
    });
    const value = response.customProfile;
    const text = typeof value === 'string' ? profileText(value) : value == null ? '' : JSON.stringify(value, null, 2);
    return { contactId: args.contactId, profile: text || 'This contact has no custom profile, or it is empty' };
  }

  async listContacts(args: ListContactsArgs = {}): Promise<ListContactsResult> {
    if (args.orphansOnly) return this.listOrphans(args);

    const filter = {
      ...(args.search ? { search: args.search } : {}),
      ...(args.email ? { email: args.email.trim().toLowerCase() } : {}),
    };
    const variables = {
      first: args.limit || 20,
      after: args.after,
      filter: Object.keys(filter).length ? filter : undefined,
      orderBy: args.orderBy
        ? { field: args.orderBy.field, direction: args.orderBy.direction ?? 'ASC' }
        : undefined,
    };

    const response = await this.client.request<{
      contacts: {
        totalCount: number;
        nodes: Contact[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(queries.listContacts, variables);

    return {
      contacts: response.contacts.nodes,
      totalCount: response.contacts.totalCount,
      pageInfo: response.contacts.pageInfo,
    };
  }

  // Groove can't filter on ticket count, and its sort by count is not strict and may not end.
  // So each call reads a few pages and keeps the zeros, and never promises a complete list.
  private async listOrphans(args: ListContactsArgs): Promise<ListContactsResult> {
    const wanted = args.limit || 50;
    const createdBefore = args.olderThanDays
      ? Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000
      : undefined;
    const seen = new Set<string>();
    const contacts: Contact[] = [];
    let after = args.after;
    let totalCount = 0;
    let pageInfo: ListContactsResult['pageInfo'] = { hasNextPage: false, endCursor: null };

    for (let page = 0; page < MAX_ORPHAN_PAGES && contacts.length < wanted; page++) {
      const result = await this.listContacts({
        orderBy: { field: 'CONVERSATION_COUNT', direction: 'ASC' },
        limit: ORPHAN_PAGE_SIZE,
        after,
      });
      totalCount = result.totalCount;
      pageInfo = result.pageInfo;
      after = result.pageInfo.endCursor ?? undefined;

      for (const contact of result.contacts) {
        if (seen.has(contact.id)) continue;
        seen.add(contact.id);
        const oldEnough = !createdBefore || Date.parse(contact.createdAt) < createdBefore;
        if (contact.conversationCount === 0 && oldEnough) contacts.push(contact);
      }

      if (!result.pageInfo.hasNextPage) break;
    }

    return {
      contacts,
      totalCount,
      pageInfo,
      contactsRead: seen.size,
      note:
        'A partial list: pass pageInfo.endCursor as after for the next batch. Groove may repeat contacts between batches. ' +
        '0 tickets can also mean the contact was only CCed or wrote mail in a merged ticket.',
    };
  }

  async getContact(id: string): Promise<Contact | null> {
    const response = await this.client.request<{
      node: Contact | null;
    }>(queries.getContact, { id });

    return response.node;
  }

  async createContact(args: CreateContactArgs): Promise<Contact> {
    this.checkValues([args.email], EMAIL_PATTERN, 'email address');

    const payload = await this.client.mutate<{ contact: Contact }>(
      mutations.contactCreate,
      'contactCreate',
      { contactType: 'contact', customFields: toCustomFields(args), skipCompanyCreation: true }
    );

    return payload.contact;
  }

  async updateContact(args: UpdateContactArgs): Promise<Contact | null> {
    const customFieldList = toCustomFields(args);
    const addIds = args.companyIds ?? [];
    const removeIds = args.removeCompanyIds ?? [];
    const addEmails = (args.addSecondaryEmails ?? []).map(email => email.trim().toLowerCase());
    const removeEmails = (args.removeSecondaryEmails ?? []).map(email => email.trim().toLowerCase());

    if (
      customFieldList.length === 0 &&
      !addIds.length &&
      !removeIds.length &&
      !addEmails.length &&
      !removeEmails.length
    ) {
      throw new Error(
        'Provide at least one of email, firstName, lastName, title, phone, companyIds, removeCompanyIds, addSecondaryEmails or removeSecondaryEmails'
      );
    }
    this.checkValues(
      [...addEmails, ...(args.email === undefined ? [] : [args.email])],
      EMAIL_PATTERN,
      'email address'
    );
    if (removeEmails.some(email => addEmails.includes(email))) {
      throw new Error('An address cannot be in both addSecondaryEmails and removeSecondaryEmails');
    }
    if (removeIds.some(id => addIds.includes(id))) {
      throw new Error('A company cannot be in both companyIds and removeCompanyIds');
    }

    if (customFieldList.length) {
      await this.client.mutate(mutations.customFieldValuesUpdate, 'customFieldValuesUpdate', {
        subjectId: args.id,
        customFieldList,
      });
    }

    if (addEmails.length || removeEmails.length) {
      const contact = await this.getContact(args.id);
      await this.changeList(
        args.id,
        'contact_secondary_emails',
        contact?.secondaryEmails ?? [],
        addEmails,
        removeEmails
      );
    }

    const contactIds = [args.id];
    for (const companyId of removeIds) {
      await this.client.mutate(mutations.companyRemoveContacts, 'companyRemoveContacts', {
        companyId,
        contactIds,
      });
    }
    for (const companyId of addIds) {
      await this.client.mutate(mutations.companyAddContacts, 'companyAddContacts', {
        companyId,
        contactIds,
      });
    }

    return this.getContact(args.id);
  }

  async updateCompany(args: UpdateCompanyArgs) {
    const addDomains = (args.addDomains ?? []).map(domain => domain.trim().toLowerCase());
    const removeDomains = (args.removeDomains ?? []).map(domain => domain.trim().toLowerCase());

    if (args.name === undefined && !addDomains.length && !removeDomains.length) {
      throw new Error('Provide at least one of name, addDomains or removeDomains');
    }
    this.checkValues(addDomains, DOMAIN_PATTERN, 'domain');
    if (removeDomains.some(domain => addDomains.includes(domain))) {
      throw new Error('A domain cannot be in both addDomains and removeDomains');
    }

    if (args.name !== undefined) {
      await this.client.mutate(mutations.customFieldValuesUpdate, 'customFieldValuesUpdate', {
        subjectId: args.id,
        customFieldList: [{ customFieldIdOrKey: 'company_name', value: args.name }],
      });
    }

    if (addDomains.length || removeDomains.length) {
      const { domains } = await this.getCompany(args.id);
      await this.changeList(args.id, 'company_secondary_domains', domains, addDomains, removeDomains);
    }

    return this.getCompany(args.id);
  }

  private async getCompany(id: string) {
    const { node } = await this.client.request<{
      node:
        | (Company & {
            customFieldValues: {
              nodes: Array<{ customField: { key: string }; value: { content?: string } }>;
            };
          })
        | null;
    }>(queries.getCompany, { id });
    if (!node?.id) throw new Error(`Company not found: ${id}`);

    const { customFieldValues, ...company } = node;
    const domains = customFieldValues.nodes
      .filter(row => row.customField.key === 'company_secondary_domains')
      .map(row => row.value.content ?? '');
    return { ...company, domains };
  }

  private checkValues(values: string[], pattern: RegExp, label: string): void {
    const invalid = values.find(value => !pattern.test(value));
    if (invalid !== undefined) throw new Error(`Not a valid ${label}: ${invalid}`);
  }

  // Groove adds to these lists one value at a time, and can only remove the first value.
  // So removing clears the list and puts the rest back.
  private async changeList(
    subjectId: string,
    key: string,
    current: string[],
    add: string[],
    remove: string[]
  ): Promise<void> {
    const lower = current.map(value => value.toLowerCase());
    const missing = remove.find(value => !lower.includes(value));
    if (missing !== undefined) throw new Error(`${missing} is not on this list`);

    const addValue = (value: string) =>
      this.client.mutate(mutations.customFieldValuesUpdate, 'customFieldValuesUpdate', {
        subjectId,
        customFieldList: [{ customFieldIdOrKey: key, value }],
      });

    if (remove.length) {
      const { customFields } = await this.client.request<{
        customFields: { nodes: Array<{ id: string; key: string }> };
      }>(queries.listCustomFields);
      const customFieldId = customFields.nodes.find(field => field.key === key)?.id;
      if (!customFieldId) throw new Error(`Custom field not found: ${key}`);

      const keep = current.filter(value => !remove.includes(value.toLowerCase()));
      try {
        for (let index = 0; index < current.length; index++) {
          await this.client.mutate(mutations.customFieldRemove, 'customFieldRemove', {
            customFieldId,
            itemId: subjectId,
          });
        }
        for (const value of keep) await addValue(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (the list should be: ${keep.join(', ') || 'empty'})`);
      }
    }

    for (const value of add) await addValue(value);
  }

  async listCompanies(args: ListCompaniesArgs = {}) {
    const response = await this.client.request<{
      companies: {
        nodes: Company[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(queries.listCompanies, {
      first: args.limit || 20,
      after: args.after,
      filter: args.search ? { search: args.search } : undefined,
      orderBy: args.orderBy
        ? { field: args.orderBy.field, direction: args.orderBy.direction ?? 'ASC' }
        : undefined,
    });

    return { companies: response.companies.nodes, pageInfo: response.companies.pageInfo };
  }

  async mergeContacts(args: MergeContactsArgs) {
    const source = await this.findContact(args.source);
    const target = await this.findContact(args.target);
    if (source.id === target.id) throw new Error('Cannot merge a contact into itself');

    const payload = await this.client.mutate<{ target: Contact }>(
      mutations.contactMerge,
      'contactMerge',
      { sourceId: source.id, targetId: target.id }
    );

    return { merged: true, mergedContact: source.email, contact: payload.target };
  }

  async deleteContact(args: DeleteContactArgs) {
    const { contacts } = await this.listContacts({ email: args.email, limit: 5 });
    const email = args.email.trim().toLowerCase();
    const matches = contacts.filter(contact => contact.email?.toLowerCase() === email);

    if (!matches.length) return { found: false, deleted: false, email };
    if (matches.length > 1) {
      return { found: true, deleted: false, reason: 'More than one contact has this address', matches };
    }

    const [contact] = matches;
    if (contact.conversationCount !== 0) throw new Error(this.hasTickets(contact));

    const details = { id: contact.id, email: contact.email, name: contact.name };
    if (args.confirm !== true) {
      return { found: true, deleted: false, wouldDelete: details, warning: SENDER_WARNING };
    }

    await this.removeContact(contact.id);
    return { found: true, deleted: true, deletedContact: details };
  }

  async deleteContacts(args: DeleteContactsArgs) {
    const ids = [...new Set(args.contactIds)];
    if (!ids.length) throw new Error('Provide at least one contact ID');
    if (ids.length > MAX_BULK_DELETE) {
      throw new Error(`Delete at most ${MAX_BULK_DELETE} contacts per call, got ${ids.length}`);
    }

    const results: DeleteOutcome[] = [];
    for (const id of ids) {
      results.push(await this.deleteOne(id, args.confirm === true));
    }

    const count = (status: DeleteOutcome['status']) =>
      results.filter(result => result.status === status).length;

    return {
      confirmed: args.confirm === true,
      deleted: count('deleted'),
      skipped: count('skipped'),
      failed: count('failed'),
      warning: args.confirm ? undefined : SENDER_WARNING,
      results,
    };
  }

  // Checks each contact right before deleting it, so one that got a ticket in the meantime stays
  private async deleteOne(id: string, confirm: boolean): Promise<DeleteOutcome> {
    try {
      const contact = await this.withRetry(() => this.getContact(id));
      if (!contact?.id) return { id, status: 'skipped', reason: 'Contact not found' };
      const { email, name } = contact;
      if (contact.conversationCount !== 0) {
        return { id, status: 'skipped', email, reason: this.hasTickets(contact) };
      }
      if (!confirm) return { id, status: 'would delete', email, name };

      await this.withRetry(() => this.removeContact(id));
      await sleep(BULK_DELETE_PAUSE_MS);
      return { id, status: 'deleted', email, name };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { id, status: 'failed', reason };
    }
  }

  private async withRetry<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= RATE_LIMIT_RETRIES || !/429|rate limit|too many requests/i.test(message)) {
          throw error;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  private async removeContact(contactId: string): Promise<void> {
    await this.client.mutate(mutations.contactDelete, 'contactDelete', { contactId });
  }

  // Any answer but 0 keeps the contact, also when Groove leaves the count out
  private hasTickets(contact: Contact): string {
    if (typeof contact.conversationCount !== 'number') {
      return `${contact.email} cannot be deleted: Groove gave no ticket count.`;
    }
    return (
      `${contact.email} has ${contact.conversationCount} ticket(s) and cannot be deleted. ` +
      'Move them first with mergeContacts.'
    );
  }

  // Takes a contact ID or an exact email address
  private async findContact(idOrEmail: string): Promise<Contact> {
    const value = idOrEmail.trim();
    if (value.startsWith('co_')) {
      const contact = await this.getContact(value);
      if (!contact?.id) throw new Error(`Contact not found: ${value}`);
      return contact;
    }

    const email = value.toLowerCase();
    const { contacts } = await this.listContacts({ email, limit: 5 });
    const matches = contacts.filter(contact => contact.email?.toLowerCase() === email);
    if (matches.length !== 1) {
      throw new Error(
        matches.length ? `More than one contact has ${email}` : `Contact not found: ${email}`
      );
    }
    return matches[0];
  }
}

export const listContacts = defineTool<ListContactsArgs>({
  name: 'listContacts',
  setting: 'read',
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
  handler: (args, { contacts }) => contacts.listContacts(args),
});

export const listCompanies = defineTool<ListCompaniesArgs>({
  name: 'listCompanies',
  setting: 'read',
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
  handler: (args, { contacts }) => contacts.listCompanies(args),
});

export const updateCompany = defineTool<UpdateCompanyArgs>({
  name: 'updateCompany',
  setting: 'write',
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
  handler: (args, { contacts }) => contacts.updateCompany(args),
});

export const mergeContacts = defineTool<MergeContactsArgs>({
  name: 'mergeContacts',
  setting: 'merge',
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
  handler: (args, { contacts }) => contacts.mergeContacts(args),
});

export const deleteContact = defineTool<DeleteContactArgs>({
  name: 'deleteContact',
  setting: 'write',
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
  handler: (args, { contacts }) => contacts.deleteContact(args),
});

export const deleteContacts = defineTool<DeleteContactsArgs>({
  name: 'deleteContacts',
  setting: 'write',
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
  handler: (args, { contacts }) => contacts.deleteContacts(args),
});

export const getContactProfile = defineTool<{ contactId: string; channelId?: string; refresh?: boolean }>({
  name: 'getContactProfile',
  setting: 'read',
  annotations: READ_TOOL,
  description:
    "Get the extra details your own integration shows next to a contact in Groove (Groove's custom profile), as plain text",
  inputSchema: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: 'The contact ID (co_...)',
      },
      channelId: {
        type: 'string',
        description: 'The mailbox the profile is shown in, if it differs per mailbox',
      },
      refresh: {
        type: 'boolean',
        description: 'Ask the integration for fresh details instead of what Groove has stored',
      },
    },
    required: ['contactId'],
  },
  handler: (args, { contacts }) => contacts.getContactProfile(args),
});

export const getContact = defineTool<{ id: string }>({
  name: 'getContact',
  setting: 'read',
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
  handler: async (args, { contacts }) => {
    const result = await contacts.getContact(args.id);
    if (!result) {
      throw new Error(`Contact not found: ${args.id}`);
    }
    return result;
  },
});

export const createContact = defineTool<CreateContactArgs>({
  name: 'createContact',
  setting: 'write',
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
  handler: (args, { contacts }) => contacts.createContact(args),
});

export const updateContact = defineTool<UpdateContactArgs>({
  name: 'updateContact',
  setting: 'write',
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
  handler: (args, { contacts }) => contacts.updateContact(args),
});
