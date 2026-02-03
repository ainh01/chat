const gql = require('graphql-tag');

const typeDefs = gql`  
  """  
  User Object Type  
  
  Represents an authenticated user in the system.  
  Password hashes are NEVER exposed through GraphQL.  
  
  Fields:  
  - id: Unique 16-digit numeric identifier (stored as String due to BigInt)  
  - username: Unique username, case-insensitive, lowercase stored  
  
  Note: ID is String not Int because GraphQL Int is 32-bit signed  
  (max: 2,147,483,647), but we need 16-digit numbers up to 9×10^15  
  """  
  type User {  
    id: ID!  
    username: String!  
  }  

  """  
  Authentication Response  
  
  Returned by login and register mutations.  
  
  Fields:  
  - success: Operation outcome (true/false)  
  - message: Human-readable status message  
  - user: User object if successful, null if failed  
  
  Design Note: We use a response wrapper rather than returning User directly  
  to provide consistent error messaging without relying solely on GraphQL errors.  
  """  
  type AuthResponse {  
    success: Boolean!  
    message: String!  
    user: User  
  }  

  """  
  Logout Response  
  
  Simple success indicator for logout operation.  
  """  
  type LogoutResponse {  
    success: Boolean!  
    message: String!  
  }  

  """  
  Protected Data Response  
  
  Demonstrates authorization on queries.  
  Returns arbitrary data that requires authentication.  
  """  
  type ProtectedDataResponse {  
    message: String!  
    user: User!  
    timestamp: String!  
  }  

  """  
  Query Operations (Read-Only)  
  
  Queries should be idempotent and have no side effects.  
  """  
  type Query {  
    """  
    Protected Query - Requires Authentication  
    
    Demonstrates session-based authorization.  
    Returns user info and timestamp if authenticated.  
    Throws UNAUTHENTICATED error if no valid session.  
    
    Usage: Call after login to verify session is active.  
    """  
    me: ProtectedDataResponse!  
    
    """  
    Health check query (public, no authentication)  
    Useful for monitoring and debugging  
    """  
    healthCheck: String!  
  }  

  """  
  Mutation Operations (Write Operations)  
  
  Mutations modify server state and should clearly indicate side effects.  
  """  
  type Mutation {  
    """  
    User Registration  
    
    Creates new user account with hashed password.  
    
    Arguments:  
    - username: 3-255 characters, alphanumeric + underscore recommended  
    - password: Minimum 8 characters, will be hashed with bcrypt  
    
    Returns:  
    - Success: { success: true, user: { id, username }, message }  
    - Failure: { success: false, user: null, message: "error details" }  
    
    Errors:  
    - Username already exists  
    - Invalid input (too short, etc.)  
    - Database connection issues  
    
    Security: Does NOT automatically log in user (prevents session fixation)  
    """  
    register(username: String!, password: String!): AuthResponse!  

    """  
    User Login  
    
    Authenticates user and creates server-side session.  
    
    Arguments:  
    - username: Case-insensitive  
    - password: Plain text (transmitted over HTTPS in production)  
    
    Side Effects:  
    - Creates session in Redis with 7-day TTL  
    - Sets HttpOnly session cookie in response  
    
    Returns:  
    - Success: { success: true, user: { id, username }, message }  
    - Failure: { success: false, user: null, message: "Invalid credentials" }  
    
    Security Notes:  
    - Password compared using bcrypt (constant-time)  
    - Failed attempts should be rate-limited (implement externally)  
    - Consider adding account lockout after N failed attempts  
    """  
    login(username: String!, password: String!): AuthResponse!  

    """  
    User Logout  
    
    Destroys server-side session and clears cookie.  
    
    Side Effects:  
    - Deletes session from Redis  
    - Clears session cookie (sets expiry to past date)  
    - Subsequent requests with old cookie will be unauthenticated  
    
    Returns:  
    - Always succeeds (even if not logged in)  
    - { success: true, message: "Logged out successfully" }  
    
    Idempotent: Calling multiple times has same effect  
    """  
    logout: LogoutResponse!  
  }  
`;

module.exports = {
  typeDefs
};
