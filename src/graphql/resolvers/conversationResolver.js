const { GraphQLError } = require('graphql');
const { requireAuth } = require('../../middleware/auth');
const { findUserById } = require('../../models/UserCore');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const User = require('../../models/User');
const {
  pubsub,
  MESSAGE_SENT,
  READ_STATUS_CHANGED,
  USER_STATUS_CHANGED,
  TYPING
} = require('../../pubsub/events');
const { withFilter } = require('graphql-subscriptions');

const conversationResolvers = {
  DateTime: {
    serialize(value) {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return null;
    },

    parseValue(value) {
      if (typeof value === 'string') {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
      throw new GraphQLError('Invalid DateTime format (expected ISO 8601)', {
        extensions: { code: 'BAD_REQUEST' }
      });
    },

    parseLiteral(ast) {
      if (ast.kind === 'StringValue') {
        return new Date(ast.value);
      }
      return null;
    }
  },

  JSON: {
    serialize(value) {
      return value;
    },
    parseValue(value) {
      return value;
    },
    parseLiteral(ast) {
      return ast.value;
    }
  },

  Message: {
    content(parent) {
      if (parent.meta?.is_unsent) {
        return null;
      }
      return parent.content;
    },

    id(parent) {
      return parent._id.toString();
    },

    conversationId(parent) {
      return parent.conversation_id.toString();
    },

    senderId(parent) {
      return parent.sender_id;
    },

    recipientId(parent) {
      return parent.recipient_id;
    },

    timeSent(parent) {
      return parent.time_sent;
    }
  },

  Conversation: {
    id(parent) {
      return parent._id.toString();
    },

    participantIds(parent) {
      return parent.participant_ids;
    },

    lastMessage(parent) {
      if (!parent.last_message) return null;

      return {
        senderId: parent.last_message.sender_id,
        text: parent.last_message.text,
        timeSent: parent.last_message.time_sent
      };
    },

    readStatus(parent) {
      return parent.read_status ? Object.fromEntries(parent.read_status) : {};
    },

    createdAt(parent) {
      return parent.created_at;
    }
  },

  User: {
    id(parent) {
      return parent._id || parent.id;
    },
    lastOnline(parent) {
      return parent.last_online;
    }
  },

  Query: {
    async fetchMessages(_, { conversationId, cursor, limit = 20 }, context) {
      const user = requireAuth(context);

      let conversation;
      try {
        conversation = await Conversation.findById(conversationId);
      } catch (error) {
        throw new GraphQLError('Invalid conversation ID format', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (!conversation) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      if (!conversation.participant_ids.includes(user.id)) {
        throw new GraphQLError('You are not a participant in this conversation', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      let cursorDate = new Date();
      if (cursor) {
        try {
          const decodedCursor = Buffer.from(cursor, 'base64').toString('utf-8');
          cursorDate = new Date(decodedCursor);

          if (isNaN(cursorDate.getTime())) {
            throw new Error('Invalid date');
          }
        } catch (error) {
          throw new GraphQLError('Invalid cursor format', {
            extensions: { code: 'BAD_REQUEST' }
          });
        }
      }

      const safeLimit = Math.min(Math.max(limit, 1), 100);

      const messages = await Message.find({
        conversation_id: conversation._id,
        time_sent: { $lt: cursorDate }
      })
        .sort({ time_sent: -1 })
        .limit(safeLimit + 1)
        .lean();

      const hasNextPage = messages.length > safeLimit;
      const messageNodes = messages.slice(0, safeLimit);

      const edges = messageNodes.map(msg => ({
        cursor: Buffer.from(msg.time_sent.toISOString()).toString('base64'),
        node: msg
      }));

      const endCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

      return {
        edges,
        pageInfo: {
          hasNextPage,
          endCursor
        }
      };
    },

    async getReadStatus(_, { conversationId }, context) {
      const user = requireAuth(context);

      let conversation;
      try {
        conversation = await Conversation.findById(conversationId).select('participant_ids read_status');
      } catch (error) {
        throw new GraphQLError('Invalid conversation ID format', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (!conversation) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      if (!conversation.participant_ids.includes(user.id)) {
        throw new GraphQLError('You are not a participant in this conversation', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      return {
        conversationId: conversation._id.toString(),
        status: conversation.read_status ? Object.fromEntries(conversation.read_status) : {}
      };
    },

    async getLastOnline(_, { userId }, context) {
      const user = requireAuth(context);

      if (!userId || typeof userId !== 'string') {
        throw new GraphQLError('Invalid user ID', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      const sharedConversation = await Conversation.findOne({
        participant_ids: { $all: [user.id, userId] }
      });

      if (!sharedConversation) {
        throw new GraphQLError('Not connected to this user', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      let targetUser = await User.findById(userId);

      if (!targetUser) {
        throw new GraphQLError('User not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const twoMinutesAgo = new Date(Date.now() - 120000);
      const isOnline = targetUser.last_online >= twoMinutesAgo;

      return {
        userId: targetUser._id,
        lastOnline: targetUser.last_online,
        isOnline
      };
    }
  },

  Mutation: {
    async createConversation(_, { participantId }, context) {
      const user = requireAuth(context);

      if (!participantId || typeof participantId !== 'string') {
        throw new GraphQLError('Invalid participant ID', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (participantId === user.id) {
        throw new GraphQLError('Cannot create conversation with yourself', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      const participantUser = await findUserById(participantId);
      if (!participantUser) {
        throw new GraphQLError('Participant user not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const sortedIds = [user.id, participantId].sort();
      let conversation = await Conversation.findOne({
        participant_ids: sortedIds
      });

      if (!conversation) {
        conversation = new Conversation({
          participant_ids: sortedIds,
          last_message: null,
          read_status: new Map(),
          created_at: new Date(),
          is_blocked: false
        });

        await conversation.save();
      }

      return conversation;
    },

    async sendMessage(_, { conversationId, content }, context) {
      const user = requireAuth(context);

      let conversation;
      try {
        conversation = await Conversation.findById(conversationId);
      } catch (error) {
        throw new GraphQLError('Invalid conversation ID format', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (!conversation) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      if (!conversation.participant_ids.includes(user.id)) {
        throw new GraphQLError('You are not a participant in this conversation', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      const trimmedContent = content.trim();

      if (trimmedContent.length === 0) {
        throw new GraphQLError('Message content cannot be empty', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (trimmedContent.length > 5000) {
        throw new GraphQLError('Message content exceeds maximum length (5000 characters)', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      const recipientId = conversation.participant_ids.find(id => id !== user.id);

      if (!recipientId) {
        throw new GraphQLError('Conversation must have exactly 2 participants', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' }
        });
      }

      const message = new Message({
        conversation_id: conversation._id,
        sender_id: user.id,
        recipient_id: recipientId,
        content: trimmedContent,
        time_sent: new Date(),
        meta: {
          is_unsent: false,
          is_forwarded: false,
          reply_to: null,
          last_edit_at: null
        },
        reactions: []
      });

      await message.save();

      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            last_message: {
              sender_id: user.id,
              text: trimmedContent.substring(0, 100),
              time_sent: message.time_sent
            }
          }
        }
      );

      pubsub.publish(MESSAGE_SENT, {
        messageReceived: message,
        conversationId: conversation._id.toString()
      });

      return message;
    },

    async markAsRead(_, { conversationId }, context) {
      const user = requireAuth(context);

      let conversation;
      try {
        conversation = await Conversation.findById(conversationId);
      } catch (error) {
        throw new GraphQLError('Invalid conversation ID format', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (!conversation) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      if (!conversation.participant_ids.includes(user.id)) {
        throw new GraphQLError('You are not a participant in this conversation', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      const timestamp = new Date();

      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            [`read_status.${user.id}`]: timestamp
          }
        }
      );

      const receipt = {
        conversationId: conversation._id.toString(),
        userId: user.id,
        timestamp
      };

      pubsub.publish(READ_STATUS_CHANGED, {
        readStatusChanged: receipt,
        conversationId: conversation._id.toString()
      });

      return receipt;
    },

    async updateLastOnline(_, __, context) {
      const user = requireAuth(context);

      const { redisClient } = context;

      if (!redisClient) {
        throw new GraphQLError('Redis client not available', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' }
        });
      }

      const redisKey = `last_online:${user.id}`;

      try {
        const lastUpdate = await redisClient.get(redisKey);
        const now = Date.now();

        if (!lastUpdate || (now - parseInt(lastUpdate)) > 60000) {
          const timestamp = await User.updateLastOnline(user.id);

          await redisClient.set(redisKey, now.toString(), { EX: 300 });

          pubsub.publish(USER_STATUS_CHANGED, {
            userId: user.id,
            lastOnline: timestamp
          });

          return {
            _id: user.id,
            last_online: timestamp
          };
        }

        const cachedUser = await User.findById(user.id);
        return cachedUser || { _id: user.id, last_online: new Date() };

      } catch (error) {
        throw new GraphQLError('Failed to update last online status', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' }
        });
      }
    },

    async setTyping(_, { conversationId, isTyping }, context) {
      const user = requireAuth(context);

      let conversation;
      try {
        conversation = await Conversation.findById(conversationId).select('participant_ids');
      } catch (error) {
        throw new GraphQLError('Invalid conversation ID format', {
          extensions: { code: 'BAD_REQUEST' }
        });
      }

      if (!conversation) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      if (!conversation.participant_ids.includes(user.id)) {
        throw new GraphQLError('You are not a participant in this conversation', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      pubsub.publish(TYPING, {
        typingIndicator: {
          conversationId: conversation._id.toString(),
          userId: user.id,
          isTyping
        },
        conversationId: conversation._id.toString()
      });

      return true;
    }
  },

  Subscription: {
    messageReceived: {
      subscribe: withFilter(
        () => pubsub.asyncIterator([MESSAGE_SENT]),

        async (payload, variables, context) => {
          if (!context.user) {
            return false;
          }

          if (payload.conversationId !== variables.conversationId) {
            return false;
          }

          const conversation = await Conversation.findById(variables.conversationId);

          if (!conversation) {
            return false;
          }

          if (!conversation.participant_ids.includes(context.user.id)) {
            return false;
          }

          return true;
        }
      ),

      resolve(payload) {
        return payload.messageReceived;
      }
    },

    readStatusChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator([READ_STATUS_CHANGED]),

        async (payload, variables, context) => {
          try {
            if (!context.user) {
              return false;
            }

            const payloadConvId = payload.conversationId.toString();
            const variableConvId = variables.conversationId.toString();

            if (payloadConvId !== variableConvId) {
              return false;
            }

            if (payload.readStatusChanged.userId === context.user.id) {
              return false;
            }

            const conversation = await Conversation.findById(variables.conversationId);

            if (!conversation) {
              return false;
            }

            if (!conversation.participant_ids.includes(context.user.id)) {
              return false;
            }

            return true;
          } catch (error) {
            return false;
          }
        }
      ),

      resolve(payload) {
        return payload.readStatusChanged;
      }
    },

    typingIndicator: {
      subscribe: withFilter(
        () => pubsub.asyncIterator([TYPING]),

        async (payload, variables, context) => {
          try {
            if (!context.user) {
              return false;
            }

            const payloadConvId = payload.conversationId.toString();
            const variableConvId = variables.conversationId.toString();

            if (payloadConvId !== variableConvId) {
              return false;
            }

            if (payload.typingIndicator.userId === context.user.id) {
              return false;
            }

            const conversation = await Conversation.findById(variables.conversationId);

            if (!conversation) {
              return false;
            }

            if (!conversation.participant_ids.includes(context.user.id)) {
              return false;
            }

            return true;
          } catch (error) {
            return false;
          }
        }
      ),

      resolve(payload) {
        return payload.typingIndicator;
      }
    }
  }
};

module.exports = { conversationResolvers };