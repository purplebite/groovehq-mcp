import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Contact } from '../types/groove.js';

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

export class ContactTools {
  constructor(private client: GrooveClient) {}

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
    const payload = await this.client.mutate<{ contact: Contact }>(
      mutations.contactCreate,
      'contactCreate',
      { contactType: 'contact', customFields: toCustomFields(args), skipCompanyCreation: true }
    );

    return payload.contact;
  }

  async updateContact(args: UpdateContactArgs): Promise<Contact | null> {
    const customFieldList = toCustomFields(args);

    if (customFieldList.length === 0) {
      throw new Error('Provide at least one of email, firstName, lastName, title or phone');
    }

    await this.client.mutate(mutations.customFieldValuesUpdate, 'customFieldValuesUpdate', {
      subjectId: args.id,
      customFieldList,
    });

    return this.getContact(args.id);
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
    if (contact.conversationCount) throw new Error(this.hasTickets(contact));

    const details = { id: contact.id, email: contact.email, name: contact.name };
    if (!args.confirm) {
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
      if (contact.conversationCount) {
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

  private hasTickets(contact: Contact): string {
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
