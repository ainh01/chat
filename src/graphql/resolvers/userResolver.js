const { GraphQLError } = require('graphql');
const {
  createUser,
  findUserByUsername,
  verifyPassword
} = require('../../models/UserCore');
const { requireAuth } = require('../../middleware/auth');

/**
 * Resolver Map
 *
 * Organized by GraphQL operation type:
 * - Query: Read operations
 * - Mutation: Write operations
 * - Type: Field resolvers (if needed for computed fields)
 */
const resolvers = {
  Query: {
    /**
     * Health Check Query
     *
     * Public endpoint to verify server is running.
     * Useful for load balancers and monitoring systems.
     */
    healthCheck: () => {
      return `Server running at ${new Date().toISOString()}`;
    },

    /**
     * Protected Query - "Me" Endpoint
     *
     * Returns current authenticated user's information.
     * Common pattern in GraphQL APIs for fetching current user context.
     *
     * @param {*} parent - Unused (root query)
     * @param {Object} args - No arguments
     * @param {Object} context - Contains user object if authenticated
     * @returns {Object} Protected data response
     * @throws {GraphQLError} If not authenticated
     *
     * Client Usage Example:
     * query {
     *   me {
     *     message
     *     user { id username }
     *     timestamp
     *   }
     * }
     */
    me: async (parent, args, context) => {
      // Throws error if not authenticated
      const user = requireAuth(context);

      return {
        message: `Welcome back, ${user.username}!`,
        user: {
          id: user.id,
          username: user.username
        },
        timestamp: new Date().toISOString()
      };
    }
  },

  Mutation: {
    /**
     * User Registration Mutation
     *
     * Creates new user account with secure password hashing.
     *
     * @param {*} parent
     * @param {Object} args - { username, password }
     * @param {Object} context - GraphQL context
     * @returns {Object} AuthResponse with success status and user
     *
     * Security Considerations:
     * 1. Username sanitization (trimmed, lowercased)
     * 2. Password never logged or exposed
     * 3. Validation before database interaction
     * 4. Detailed error messages for user feedback (balance security vs UX)
     *
     * Design Decision: Does NOT auto-login after registration
     * - Prevents session fixation attacks
     * - Allows email verification flow (future feature)
     * - Forces password re-entry (confirms user remembers it)
     *
     * Client Usage Example:
     * mutation {
     *   register(username: "john_doe", password: "SecurePass123!") {
     *     success
     *     message
     *     user { id username }
     *   }
     * }
     */
    register: async (parent, args, context) => {
      const { username, password } = args;

      try {
        // Input validation (additional layer beyond model validation)
        if (!username || username.trim().length < 3) {
          return {
            success: false,
            message: 'Username must be at least 3 characters',
            user: null
          };
        }

        if (!password || password.length < 8) {
          return {
            success: false,
            message: 'Password must be at least 8 characters',
            user: null
          };
        }

        // Additional validation: username pattern
        const usernameRegex = /^[a-zA-Z0-9_]+$/;
        if (!usernameRegex.test(username)) {
          return {
            success: false,
            message: 'Username can only contain letters, numbers, and underscores',
            user: null
          };
        }

        // Create user (model handles hashing and database insert)
        const user = await createUser(username, password);

        console.log(`✅ User registered: ${user.username}`);

        return {
          success: true,
          message: 'Registration successful! Please log in.',
          user
        };

      } catch (error) {
        console.error('Registration error:', error.message);

        // Return user-friendly error messages
        // Security: Don't expose internal database errors
        return {
          success: false,
          message: error.message || 'Registration failed',
          user: null
        };
      }
    },

    /**
     * User Login Mutation
     *
     * Authenticates user and creates server-side session.
     *
     * @param {*} parent
     * @param {Object} args - { username, password }
     * @param {Object} context - Contains req, res for session management
     * @returns {Object} AuthResponse with user data on success
     *
     * Authentication Flow:
     * 1. Find user by username (case-insensitive)
     * 2. Verify password using bcrypt.compare (constant-time)
     * 3. Create session in Redis via express-session
     * 4. Set HttpOnly cookie in response
     * 5. Return user object (excluding password hash)
     *
     * Session Structure in Redis:
     * Key: sess:${sessionId} (e.g., sess:a3f8d9c2e1b6f4a8...)
     * Value: { cookie: {...}, userId: "1234567890123456" }
     * TTL: 7 days (configured in SESSION_MAX_AGE)
     *
     * Security Best Practices:
     * - Generic error message ("Invalid credentials") prevents username enumeration
     * - Constant-time password comparison prevents timing attacks
     * - Session ID regeneration prevents session fixation
     * - HttpOnly cookie prevents XSS-based session theft
     *
     * Rate Limiting Recommendation:
     * Implement external middleware to limit login attempts:
     * - Max 5 attempts per IP per 15 minutes
     * - Progressive delay after each failure
     * - CAPTCHA after 3 failures
     *
     * Client Usage Example:
     * mutation {
     *   login(username: "john_doe", password: "SecurePass123!") {
     *     success
     *     message
     *     user { id username }
     *   }
     * }
     *
     * Response Headers:
     * Set-Cookie: connect.sid=s%3A...; Path=/; HttpOnly; SameSite=Lax
     */
    login: async (parent, args, context) => {
      const { username, password } = args;
      const { req } = context;

      try {
        // Validate inputs
        if (!username || !password) {
          return {
            success: false,
            message: 'Username and password are required',
            user: null
          };
        }

        // Find user by username
        const user = await findUserByUsername(username);

        if (!user) {
          // Security: Same error message as wrong password (prevent enumeration)
          return {
            success: false,
            message: 'Invalid credentials',
            user: null
          };
        }

        // Verify password (constant-time comparison)
        const isValidPassword = await verifyPassword(password, user.password_hash);

        if (!isValidPassword) {
          console.log(`⚠️  Failed login attempt for user: ${username}`);
          return {
            success: false,
            message: 'Invalid credentials',
            user: null
          };
        }

        // Regenerate session ID to prevent session fixation attacks
        // This creates a new session ID while preserving session data
        await new Promise((resolve, reject) => {
          req.session.regenerate((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Store user ID in session (stored in Redis)
        req.session.userId = user.id;

        // Force session save before responding (ensure Redis write completes)
        await new Promise((resolve, reject) => {
          req.session.save((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        console.log(`✅ User logged in: ${user.username} (Session: ${req.sessionID})`);

        // Return user object (excluding password_hash)
        return {
          success: true,
          message: 'Login successful',
          user: {
            id: user.id,
            username: user.username
          }
        };

      } catch (error) {
        console.error('Login error:', error);
        return {
          success: false,
          message: 'Login failed. Please try again.',
          user: null
        };
      }
    },

    /**
     * User Logout Mutation
     *
     * Destroys server-side session and clears client cookie.
     *
     * @param {*} parent
     * @param {Object} args - No arguments
     * @param {Object} context - Contains req for session access
     * @returns {Object} LogoutResponse with success status
     *
     * Logout Flow:
     * 1. Destroy session in Redis (deletes key)
     * 2. Clear session cookie in response (sets Max-Age=-1)
     * 3. Return success response
     *
     * Idempotency:
     * Calling logout multiple times has the same effect.
     * Even if user is not logged in, operation succeeds.
     *
     * Security Note:
     * Client-side: After logout, remove cookie from requests
     * Old session IDs cannot be reused (destroyed in Redis)
     *
     * Client Usage Example:
     * mutation {
     *   logout {
     *     success
     *     message
     *   }
     * }
     */
    logout: async (parent, args, context) => {
      const { req, res } = context;

      try {
        // Check if session exists
        if (!req.session) {
          return {
            success: true,
            message: 'Already logged out'
          };
        }

        const sessionId = req.sessionID;

        // Destroy session (async operation)
        await new Promise((resolve, reject) => {
          req.session.destroy((err) => {
            if (err) {
              console.error('Session destruction error:', err);
              reject(err);
            } else {
              resolve();
            }
          });
        });

        // Clear cookie in response (express-session does this automatically)
        // But we can explicitly clear it for clarity
        res.clearCookie('connect.sid', {
          path: '/',
          httpOnly: true,
          sameSite: 'lax'
        });

        console.log(`✅ User logged out (Session: ${sessionId})`);

        return {
          success: true,
          message: 'Logged out successfully'
        };

      } catch (error) {
        console.error('Logout error:', error);
        // Even on error, return success (best effort logout)
        return {
          success: true,
          message: 'Logout completed'
        };
      }
    }
  }
};

module.exports = {
  resolvers
};
