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
  lastSeenAt
  secondaryEmails
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
  currentVersion {
    title
    description
    body
  }
`;

export const queries = {
  listConversations: `
    query ListConversations(
      $first: Int
      $after: String
      $filter: ConversationFilter
      $orderBy: ConversationOrder
    ) {
      conversations(
        first: $first
        after: $after
        filter: $filter
        orderBy: $orderBy
      ) {
        nodes {
          ${CONVERSATION_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        totalCount
        totalCountCapped
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

  listStateChanges: `
    query ListStateChanges($filter: EventsFilterInput!, $first: Int, $after: String) {
      events(filter: $filter, first: $first, after: $after) {
        nodes {
          createdAt
          change {
            ... on StateChanged {
              to
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

  // Asking for errors on this payload crashes it, so they are left out
  uploadPayloadGenerate: `
    mutation UploadPayloadGenerate($input: UploadPayloadGenerateInput!) {
      uploadPayloadGenerate(input: $input) {
        key
        request {
          method
          url
          data {
            name
            value
          }
        }
      }
    }
  `,

  getChannelTicket: `
    query GetChannelTicket($filter: ConversationFilter) {
      conversations(first: 1, filter: $filter) {
        nodes {
          id
        }
      }
    }
  `,

  getTicketNode: `
    query GetTicketNode($id: ID!) {
      node(id: $id) {
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

  listCompanies: `
    query ListCompanies($first: Int, $after: String, $filter: CompanyFilter, $orderBy: CompanyOrder) {
      companies(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes {
          id
          name
          domain
          conversationCount
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  getCompany: `
    query GetCompany($id: ID!) {
      node(id: $id) {
        ... on Company {
          id
          name
          domain
          conversationCount
          customFieldValues(first: 50) {
            nodes {
              customField {
                key
              }
              value {
                ... on Text {
                  content
                }
              }
            }
          }
        }
      }
    }
  `,

  listCustomFields: `
    query ListCustomFields {
      customFields(first: 100) {
        nodes {
          id
          key
        }
      }
    }
  `,

  listContacts: `
    query ListContacts($first: Int, $after: String, $filter: ContactFilter, $orderBy: ContactOrder) {
      contacts(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        totalCount
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
          username
          teams(first: 100) {
            nodes {
              id
              name
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

  listCannedReplies: `
    query ListCannedReplies($first: Int, $after: String, $filter: CannedReplyFilter) {
      cannedReplies(first: $first, after: $after, filter: $filter) {
        totalCount
        nodes {
          id
          name
          subject
          snippet
          body
          category {
            id
            name
          }
          mailboxIds
          countUsed
          lastUsedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  listRules: `
    query ListRules($first: Int, $after: String, $filter: RuleFilter) {
      rules(first: $first, after: $after, filter: $filter) {
        nodes {
          id
          name
          description
          state
          matchType
          mailboxScope
          mailboxIds
          position
          stopUpcoming
          lastRunAt
          totalExecutions
          triggers(first: 20) {
            nodes {
              type
              settings
            }
          }
          conditions(first: 50) {
            nodes {
              param
              operator
              value
            }
          }
          actions(first: 50) {
            nodes {
              type
              value
              toAgent
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

  getRawEmail: `
    query GetRawEmail($messageId: ID!) {
      rawEmail(messageId: $messageId) {
        headers {
          name
          value
        }
        bodyPlainText
      }
    }
  `,

  getCustomProfile: `
    query GetCustomProfile($contactId: ID!, $channelId: ID, $hardRefresh: Boolean) {
      customProfile(contactId: $contactId, channelId: $channelId, hardRefresh: $hardRefresh)
    }
  `,

  listLinkedResources: `
    query ListLinkedResources($filter: LinkedResourcesFilterInput!) {
      linkedResources(filter: $filter, first: 50) {
        nodes {
          provider
          externalId
          title
          url
          createdAt
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

  listTeamsWithMembers: `
    query ListTeamsWithMembers($first: Int, $after: String) {
      teams(first: $first, after: $after) {
        nodes {
          id
          name
          description
          agents(first: 100) {
            nodes {
              id
              name
              email
            }
            pageInfo {
              hasNextPage
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

  listFolders: `
    query ListFolders($first: Int, $after: String, $filter: FolderFilter) {
      folders(first: $first, after: $after, filter: $filter) {
        nodes {
          id
          name
          channelRestriction
          restriction {
            teams {
              id
              name
            }
            agents {
              id
              name
            }
          }
          channels(first: 100) {
            nodes {
              id
              name
            }
          }
          conditions(first: 20) {
            nodes {
              param
              operator
              value
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
  conversationSubject: `
    mutation ConversationSubject($input: ConversationSubjectInput!) {
      conversationSubject(input: $input) {
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

  conversationChangeContact: `
    mutation ConversationChangeContact($input: ConversationChangeContactInput!) {
      conversationChangeContact(input: $input) {
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

  conversationChangeChannel: `
    mutation ConversationChangeChannel($input: ConversationChangeChannelInput!) {
      conversationChangeChannel(input: $input) {
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

  conversationStar: `
    mutation ConversationStar($input: ConversationStarInput!) {
      conversationStar(input: $input) {
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

  conversationUnstar: `
    mutation ConversationUnstar($input: ConversationUnstarInput!) {
      conversationUnstar(input: $input) {
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

  conversationUnread: `
    mutation ConversationUnread($input: ConversationUnreadInput!) {
      conversationUnread(input: $input) {
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

  conversationLinkResource: `
    mutation ConversationLinkResource($input: conversationLinkResourceInput!) {
      conversationLinkResource(input: $input) {
        conversation {
          id
          number
        }
        errors {
          message
          path
        }
      }
    }
  `,

  // No errors field: Groove answers null for it after a successful move, which GraphQL turns into an error
  conversationMoveMessage: `
    mutation ConversationMoveMessage($input: ConversationMoveMessageInput!) {
      conversationMoveMessage(input: $input) {
        conversation {
          id
          number
          subject
        }
      }
    }
  `,

  conversationSpam: `
    mutation ConversationSpam($input: ConversationSpamInput!) {
      conversationSpam(input: $input) {
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

  conversationFollow: `
    mutation ConversationFollow($input: ConversationFollowInput!) {
      conversationFollow(input: $input) {
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

  conversationUnfollow: `
    mutation ConversationUnfollow($input: ConversationUnfollowInput!) {
      conversationUnfollow(input: $input) {
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

  conversationToggleNoteReaction: `
    mutation ConversationToggleNoteReaction($input: conversationToggleNoteReactionInput!) {
      conversationToggleNoteReaction(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  conversationEditNote: `
    mutation ConversationEditNote($input: conversationEditNoteInput!) {
      conversationEditNote(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  conversationDeleteNote: `
    mutation ConversationDeleteNote($input: conversationDeleteNoteInput!) {
      conversationDeleteNote(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  conversationUndoSend: `
    mutation ConversationUndoSend($input: conversationUndoSendInput!) {
      conversationUndoSend(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  conversationRestore: `
    mutation ConversationRestore($input: conversationRestoreInput!) {
      conversationRestore(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  conversationDelete: `
    mutation ConversationDelete($input: ConversationDeleteInput!) {
      conversationDelete(input: $input) {
        deletedConversationIds
        errors {
          message
          path
        }
      }
    }
  `,

  conversationForwardV2: `
    mutation ConversationForwardV2($input: ConversationForwardV2Input!) {
      conversationForwardV2(input: $input) {
        changesetId
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

  conversationLog: `
    mutation ConversationLog($input: ConversationLogInput!) {
      conversationLog(input: $input) {
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
        changesetId
        conversation {
          ${CONVERSATION_FIELDS}
        }
        message {
          id
          body
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
        message {
          id
          body
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

  conversationUnassign: `
    mutation ConversationUnassign($input: ConversationUnassignInput!) {
      conversationUnassign(input: $input) {
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

  conversationUntag: `
    mutation ConversationUntag($input: ConversationUntagInput!) {
      conversationUntag(input: $input) {
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

  conversationMerge: `
    mutation ConversationMerge($input: ConversationMergeInput!) {
      conversationMerge(input: $input) {
        target {
          ${CONVERSATION_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  companyAddContacts: `
    mutation CompanyAddContacts($input: CompanyAddContactsInput!) {
      companyAddContacts(input: $input) {
        company {
          id
          name
          domain
        }
        errors {
          message
          path
        }
      }
    }
  `,

  companyRemoveContacts: `
    mutation CompanyRemoveContacts($input: CompanyRemoveContactsInput!) {
      companyRemoveContacts(input: $input) {
        company {
          id
          name
          domain
        }
        errors {
          message
          path
        }
      }
    }
  `,

  customFieldRemove: `
    mutation CustomFieldRemove($input: CustomFieldRemoveInput!) {
      customFieldRemove(input: $input) {
        errors {
          message
          path
        }
      }
    }
  `,

  contactMerge: `
    mutation ContactMerge($input: ContactMergeInput!) {
      contactMerge(input: $input) {
        target {
          ${CONTACT_FIELDS}
        }
        errors {
          message
          path
        }
      }
    }
  `,

  contactDelete: `
    mutation ContactDelete($input: ContactDeleteInput!) {
      contactDelete(input: $input) {
        deletedContactId
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
