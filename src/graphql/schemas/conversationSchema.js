const { gql } = require('graphql-tag');

const conversationTypeDefs = gql`
  scalar DateTime  
  scalar JSON

type Conversation {
  id: ID!
  participantIds: [String!]!
  lastMessage: LastMessagePreview
  readStatus: JSON
  createdAt: DateTime!
}

type LastMessagePreview {
  senderId: String!
  text: String!
  timeSent: DateTime!
}

type Message {
  id: ID!
  conversationId: ID!
  senderId: String!
  recipientId: String!
  content: String
  timeSent: DateTime!
  meta: MessageMeta!
  reactions: [Reaction!]!
}

type MessageMeta {
  isUnsent: Boolean!
  isForwarded: Boolean!
  replyTo: ID
  lastEditAt: DateTime
}

type Reaction {
  userId: String!
  type: Int!
}

type MessageConnection {
  edges: [MessageEdge!]!
  pageInfo: PageInfo!
}

type MessageEdge {
  cursor: String!
  node: Message!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}

type Query {
  _empty: String
}

type Mutation {
  _empty: String
}

type Subscription {
  _empty: String
}  

  extend type Query {
  fetchMessages(
    conversationId: ID!  
      cursor: String  
      limit: Int = 20
  ): MessageConnection!
}  

  extend type Mutation {
  createConversation(
    participantId: String!
  ): Conversation!

  sendMessage(
    conversationId: ID!  
      content: String!
  ): Message!
}  

  extend type Subscription {
  messageReceived(
    conversationId: ID!
  ): Message!
}`;

module.exports = { conversationTypeDefs };  