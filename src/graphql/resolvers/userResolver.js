const { GraphQLError } = require('graphql');
const {
  createUser,
  findUserByUsername,
  verifyPassword
} = require('../../models/UserCore');
const { requireAuth } = require('../../middleware/auth');

const resolvers = {
  Query: {
    healthCheck: () => {
      return `Server running at ${new Date().toISOString()}`;
    },
    me: async (parent, args, context) => {
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
    register: async (parent, args, context) => {
      const { username, password } = args;

      try {
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
        const usernameRegex = /^[a-zA-Z0-9_]+$/;
        if (!usernameRegex.test(username)) {
          return {
            success: false,
            message: 'Username can only contain letters, numbers, and underscores',
            user: null
          };
        }
        const user = await createUser(username, password);

        return {
          success: true,
          message: 'Registration successful! Please log in.',
          user
        };

      } catch (error) {
        return {
          success: false,
          message: error.message || 'Registration failed',
          user: null
        };
      }
    },
    login: async (parent, args, context) => {
      const { username, password } = args;
      const { req } = context;

      try {
        if (!username || !password) {
          return {
            success: false,
            message: 'Username and password are required',
            user: null
          };
        }
        const user = await findUserByUsername(username);

        if (!user) {
          return {
            success: false,
            message: 'Invalid credentials',
            user: null
          };
        }
        const isValidPassword = await verifyPassword(password, user.password_hash);

        if (!isValidPassword) {
          return {
            success: false,
            message: 'Invalid credentials',
            user: null
          };
        }
        await new Promise((resolve, reject) => {
          req.session.regenerate((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        req.session.userId = user.id;
        await new Promise((resolve, reject) => {
          req.session.save((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          success: true,
          message: 'Login successful',
          user: {
            id: user.id,
            username: user.username
          }
        };

      } catch (error) {
        return {
          success: false,
          message: 'Login failed. Please try again.',
          user: null
        };
      }
    },
    logout: async (parent, args, context) => {
      const { req, res } = context;

      try {
        if (!req.session) {
          return {
            success: true,
            message: 'Already logged out'
          };
        }

        const sessionId = req.sessionID;
        await new Promise((resolve, reject) => {
          req.session.destroy((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
        res.clearCookie('connect.sid', {
          path: '/',
          httpOnly: true,
          sameSite: 'lax'
        });

        return {
          success: true,
          message: 'Logged out successfully'
        };

      } catch (error) {
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