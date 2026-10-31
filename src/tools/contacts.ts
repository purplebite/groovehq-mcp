import { GrooveClient } from '../groove-client.js';
import { queries, mutations } from '../utils/graphql-queries.js';
import { Contact } from '../types/groove.js';

interface ListContactsArgs {
  search?: string;
  limit?: number;
  after?: string;
}

interface ListContactsResult {
  contacts: Contact[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
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
    const variables = {
      first: args.limit || 20,
      after: args.after,
      filter: args.search ? { search: args.search } : undefined,
    };

    const response = await this.client.request<{
      contacts: {
        nodes: Contact[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(queries.listContacts, variables);

    return { contacts: response.contacts.nodes, pageInfo: response.contacts.pageInfo };
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
}
