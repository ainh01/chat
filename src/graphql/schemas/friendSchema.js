const gql = require('graphql-tag');

const typeDefs = gql`
type FriendRequest {
  id: ID!
  fromUserId: ID!
  toUserId: ID!
  fromUser: User
  toUser: User
  createdAt: String!
}

type Friendship {
  friendId: ID!
  friend: User
  createdAt: String!
}

type FriendRequestResponse {
  success: Boolean!
  message: String!
  request: FriendRequest
}

type FriendActionResponse {
  success: Boolean!
  message: String!
}

type FriendListResponse {
  friends: [Friendship!]!
}

type FriendRequestListResponse {
  sent: [FriendRequest!]!
  received: [FriendRequest!]!
}

type FriendshipCheckResponse {
  areFriends: Boolean!
  userId1: ID!
  userId2: ID!
}  

  extend type Query {
  myFriends: FriendListResponse!
  userFriends(userId: ID!): FriendListResponse!
  checkFriendship(userId1: ID!, userId2: ID!): FriendshipCheckResponse!
  myFriendRequests: FriendRequestListResponse!
}  

  extend type Mutation {
  sendFriendRequest(toUserId: ID!): FriendRequestResponse!
  acceptFriendRequest(requestId: ID!): FriendActionResponse!
  refuseFriendRequest(requestId: ID!): FriendActionResponse!
  removeFriend(friendId: ID!): FriendActionResponse!
}`;

module.exports = {
  typeDefs
};