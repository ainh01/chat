const gql = require('graphql-tag');

const typeDefs = gql`
type User {
  id: ID!
  username: String!
}

type AuthResponse {
  success: Boolean!
  message: String!
  user: User
}

type LogoutResponse {
  success: Boolean!
  message: String!
}

type ProtectedDataResponse {
  message: String!
  user: User!
  timestamp: String!
}

type Query {
  me: ProtectedDataResponse!
  healthCheck: String!
}

type Mutation {
  register(username: String!, password: String!): AuthResponse!
  login(username: String!, password: String!): AuthResponse!
  logout: LogoutResponse!
}`;

module.exports = {
  typeDefs
};  