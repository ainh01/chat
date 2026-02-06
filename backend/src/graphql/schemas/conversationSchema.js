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
  repliedMessage: Message
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

type ReactionUpdate {
  messageId: ID!
  reactions: [Reaction!]!
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

type ReadReceipt {
  conversationId: ID!
  userId: String!
  timestamp: DateTime!
}

type ReadStatusMap {
  conversationId: ID!
  status: JSON!
}

type LastOnlineStatus {
  userId: String!
  lastOnline: DateTime!
  isOnline: Boolean!
}

type TypingStatus {
  conversationId: ID!
  userId: String!
  isTyping: Boolean!
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

  getReadStatus(conversationId: ID!): ReadStatusMap!
  getLastOnline(userId: String!): LastOnlineStatus!
}  

extend type Mutation {
  createConversation(
    participantId: String!
  ): Conversation!

  sendMessage(
    conversationId: ID!  
    content: String!
  ): Message!

  markAsRead(conversationId: ID!): ReadReceipt!
  updateLastOnline: User!
  setTyping(conversationId: ID!, isTyping: Boolean!): Boolean!

  replyToMessage(
    conversationId: ID!  
    replyToMessageId: ID!  
    content: String!
  ): Message!

  editMessage(
    messageId: ID!  
    newContent: String!
  ): Message!

  unsendMessage(messageId: ID!): Message!

  addReaction(
    messageId: ID!  
    reactionType: Int!
  ): Message!

  removeReaction(messageId: ID!): Message!

  forwardMessage(
    messageId: ID!  
    toConversationId: ID!
  ): Message!
}  

extend type Subscription {
  messageReceived(
    conversationId: ID!
  ): Message!

  readStatusChanged(conversationId: ID!): ReadReceipt!
  typingIndicator(conversationId: ID!): TypingStatus!

  messageUpdated(conversationId: ID!): Message!
  reactionUpdated(conversationId: ID!): ReactionUpdate!
}

type User {
  id: ID!
  lastOnline: DateTime!
}
`;

module.exports = { conversationTypeDefs };