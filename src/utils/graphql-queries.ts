export const CONVERSATION_FIELDS = `
  id
  number
  state
  subject
  createdAt
  updatedAt
  stateUpdatedAt
  assigned {
    agent {
      id
      email
      name
      firstName
      lastName
    }
    team {
      id
      name
    }
    at
  }
  contact {
    id
    email
    name
    firstName
    lastName
  }
  counts {
    messages
    notes
    interactions
    attachments
    stateChanges
  }
  tags {
    nodes {
      id
      name
    }
  }
  snoozed {
    by {
      id
      email
    }
    until
  }
  starred
  channel {
    id
    name
    type
    color
  }
`;

export const MESSAGE_FIELDS = `
  id
  body
  bodyPlainText
  createdAt
  updatedAt
  isNote
  author {
    ... on Contact {
      id
      email
      name
      firstName
      lastName
    }
    ... on Agent {
      id
      email
      name
      firstName
      lastName
      role
    }
  }
  attachments {
    nodes {
      id
      fileName
      fileType
      fileSize
      url
      downloadUrl
    }
  }
`;

export const CONTACT_FIELDS = `
  id
  email
  name
  firstName
  lastName
  avatarUrl
  contactType
  conversationCount
  createdAt
  updatedAt
  companies {
    nodes {
      id
      name
    }
  }
`;

const AGENT_FIELDS = `
  id
  email
  name
  firstName
  lastName
  avatarUrl
  role
  state
`;

const KB_ARTICLE_FIELDS = `
  id
  title
  slug
  description
  body
  state
  featured
  url
  category {
    id
    title
    slug
  }
  author {
    id
    email
    name
  }
  createdAt
  updatedAt
  publishedAt
`;

export const queries = {
  listConversations: `
    query ListConversations(
      $first: Int
      $after: String
      $filter: ConversationFilter
    ) {
      conversations(
        first: $first
        after: $after
        filter: $filter
      ) {
        nodes {
          ${CONVERSATION_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  getConversation: `
    query GetConversation($id: ID!) {
      node(id: $id) {
        ... on Conversation {
          ${CONVERSATION_FIELDS}
        }
      }
    }
  `,

  listDrafts: `
    query ListDrafts($first: Int, $after: String, $filter: DraftFilter) {
      drafts(first: $first, after: $after, filter: $filter) {
        nodes {
          __typename
          id
          draftId
          draftType
          conversationId
          version
          createdAt
          updatedAt
          agent {
            id
            email
          }
          ... on ReplyDraft {
            to
            cc
            bcc
            subject
            body
          }
          ... on NoteDraft {
            body
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  getDraftTicket: `
    query GetDraftTicket($id: ID!) {
      node(id: $id) {
        ... on Conversation {
          id
          number
          channel {
            id
          }
          contact {
            id
            email
            name
            firstName
            lastName
          }
        }
      }
    }
  `,

  getConversationId: `
    query GetConversationId($number: Int!) {
      conversation(number: $number) {
        id
      }
    }
  `,

  listEvents: `
    query ListEvents($filter: EventsFilterInput!, $first: Int, $after: String) {
      events(filter: $filter, first: $first, after: $after) {
        nodes {
          change {
            ... on Message {
              ${MESSAGE_FIELDS}
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  listContacts: `
    query ListContacts($first: Int, $after: String, $filter: ContactFilter) {
      contacts(first: $first, after: $after, filter: $filter) {
        nodes {
          ${CONTACT_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  getContact: `
    query GetContact($id: ID!) {
      node(id: $id) {
        ... on Contact {
          ${CONTACT_FIELDS}
        }
      }
    }
  `,

  listAgents: `
    query ListAgents($first: Int, $after: String) {
      agents(first: $first, after: $after) {
        nodes {
          ${AGENT_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  listTags: `
    query ListTags($first: Int, $after: String, $filter: TagFilter) {
      tags(first: $first, after: $after, filter: $filter) {
        nodes {
          id
          name
          color
          conversationCount
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  listTeams: `
    query ListTeams($first: Int, $after: String) {
      teams(first: $first, after: $after) {
        nodes {
          id
          name
          description
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  listKbArticles: `
    query ListKbArticles($filter: ArticleFilter, $first: Int, $after: String) {
      articles(filter: $filter, first: $first, after: $after) {
        nodes {
          ${KB_ARTICLE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  getKbArticle: `
    query GetKbArticle($id: ID!) {
      node(id: $id) {
        ... on Article {
          ${KB_ARTICLE_FIELDS}
        }
      }
    }
  `,
};

export const mutations = {
  draftUpsert: `
    mutation DraftUpsert($input: DraftUpsertInput!) {
      draftUpsert(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  draftDelete: `
    mutation DraftDelete($input: DraftDeleteInput!) {
      draftDelete(input: $input) {
        success
        errors {
          message
          path
        }
      }
    }
  `,

  conversationCreateEmail: `
    mutation ConversationCreateEmail($input: ConversationCreateEmailInput!) {
      conversationCreateEmail(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationClose: `
    mutation ConversationClose($input: ConversationCloseInput!) {
      conversationClose(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationReply: `
    mutation ConversationReply($input: ConversationReplyInput!) {
      conversationReply(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationAddNote: `
    mutation ConversationAddNote($input: conversationAddNoteInput!) {
      conversationAddNote(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationOpen: `
    mutation ConversationOpen($input: ConversationOpenInput!) {
      conversationOpen(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationSnooze: `
    mutation ConversationSnooze($input: ConversationSnoozeInput!) {
      conversationSnooze(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationAssign: `
    mutation ConversationAssign($input: ConversationAssignInput!) {
      conversationAssign(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  conversationTag: `
    mutation ConversationTag($input: ConversationTagInput!) {
      conversationTag(input: $input) {
        conversation {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  contactCreate: `
    mutation ContactCreate($input: ContactCreateInput!) {
      contactCreate(input: $input) {
        contact {
          ${CONTACT_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  customFieldValuesUpdate: `
    mutation CustomFieldValuesUpdate($input: CustomFieldValuesUpdateInput!) {
      customFieldValuesUpdate(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,
};
