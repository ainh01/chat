const { GraphQLError } = require('graphql');
const { findUserById } = require('../models/UserCore.js');

function requireAuth(context) {
  const { req } = context;

  if (!req.session || !req.session.userId) {
    throw new GraphQLError('Authentication required', {
      extensions: {
        code: 'UNAUTHENTICATED',
        http: { status: 401 }
      }
    });
  }

  if (!context.user) {
    throw new GraphQLError('Session invalid or expired', {
      extensions: {
        code: 'UNAUTHENTICATED',
        http: { status: 401 }
      }
    });
  }

  return context.user;
}

async function buildContext({ req, res }) {
  let user = null;

  if (req.session && req.session.userId) {
    try {
      user = await findUserById(req.session.userId);

      if (!user) {
        req.session.destroy((err) => {
          if (err) console.error('Error destroying orphaned session:', err);
        });
      }
    } catch (error) {
      console.error('Error loading user in context:', error);
    }
  }

  return {
    req,
    res,
    user
  };
}

module.exports = {
  requireAuth,
  buildContext
};
