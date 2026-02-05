const express = require('express');
const http = require('http');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { ApolloServerPluginLandingPageGraphQLPlayground } = require('@apollo/server-plugin-landing-page-graphql-playground');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { WebSocketServer } = require('ws');
const { useServer } = require('graphql-ws/use/ws');
const cors = require('cors');
const dotenv = require('dotenv');

const { typeDefs: userTypeDefs } = require('./src/graphql/schemas/userSchema.js');
const { resolvers: userResolvers } = require('./src/graphql/resolvers/userResolver.js');

const { conversationTypeDefs } = require('./src/graphql/schemas/conversationSchema.js');
const { conversationResolvers } = require('./src/graphql/resolvers/conversationResolver.js');

const { typeDefs: friendTypeDefs } = require('./src/graphql/schemas/friendSchema.js');
const { resolvers: friendResolvers } = require('./src/graphql/resolvers/friendResolver.js');

const pubsubModule = require('./src/pubsub/events.js');

const pubsub = pubsubModule.pubsub;

const { buildContext } = require('./src/middleware/auth.js');
const { closePool } = require('./src/db/sql/db.js');
const { connectMongoDB, closeMongoConnection } = require('./src/db/nosql/db.js');
const { createIndexes } = require('./src/db/nosql/indexes.js');

const { createMessageLoader } = require('./src/loaders/messageLoader.js');

dotenv.config();

const PORT = process.env.PORT || 4000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 604800000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

if (!SESSION_SECRET) {
  process.exit(1);
}

if (!pubsub) {
  process.exit(1);
}
if (typeof pubsub.asyncIterator !== 'function' || typeof pubsub.publish !== 'function') {
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);

const redisClient = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        return new Error('Redis connection failed');
      }
      const delay = Math.min(retries * 100, 3000);
      return delay;
    }
  }
});

redisClient.on('error', (err) => { });
redisClient.on('connect', () => { });
redisClient.on('ready', () => { });
redisClient.on('reconnecting', () => { });

const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'sess:',
  ttl: SESSION_MAX_AGE / 1000
});

const sessionMiddleware = session({
  store: redisStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/'
  },
  name: 'connect.sid'
});

const corsOptions = {
  origin: NODE_ENV === 'production' ? FRONTEND_URL : 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const schema = makeExecutableSchema({
  typeDefs: [userTypeDefs, conversationTypeDefs, friendTypeDefs],
  resolvers: [userResolvers, conversationResolvers, friendResolvers]
});

async function getSessionFromWebSocket(ctx) {
  const cookieHeader = ctx.extra?.request?.headers?.cookie;

  if (!cookieHeader) {
    return { user: null };
  }

  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split('=');
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});

  const sessionId = cookies['connect.sid'];

  if (!sessionId) {
    return { user: null };
  }

  const unsignedSessionId = sessionId.startsWith('s:')
    ? sessionId.slice(2).split('.')[0]
    : sessionId;

  return new Promise((resolve) => {
    redisStore.get(unsignedSessionId, async (err, session) => {
      if (err) {
        return resolve({ user: null });
      }
      if (!session || !session.userId) {
        return resolve({ user: null });
      }

      try {
        const { findUserById } = require('./src/models/UserCore.js');
        const user = await findUserById(session.userId);
        resolve({ user });
      } catch (error) {
        resolve({ user: null });
      }
    });
  });
}

const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/graphql',
  handleProtocols: (protocols) => {
    if (protocols.includes('graphql-transport-ws')) return 'graphql-transport-ws';
    if (protocols.includes('graphql-ws')) return 'graphql-ws';
    return false;
  }
});

const serverCleanup = useServer({
  schema,
  onConnect: async (ctx) => {
    const { user } = await getSessionFromWebSocket(ctx);

    if (user) {
      ctx.extra.user = user;
    }
    return true;
  },

  context: async (ctx) => {
    const user = ctx.extra?.user || null;

    return {
      user,
      pubsub,
      redisClient,
      messageLoader: createMessageLoader()
    };
  },

  onSubscribe: (ctx, msg) => {
    const query = msg.payload?.query || msg.query || 'Unknown Subscription Query';
    const operationName = msg.payload?.operationName || 'N/A';
  },

  onComplete: (ctx, msg) => {
  },

  onError: (ctx, msg, errors) => {
  }
}, wsServer);

wsServer.on('connection', (ws, request) => {
});
wsServer.on('error', (error) => { });
wsServer.on('close', () => { });

const apolloServer = new ApolloServer({
  schema,
  plugins: [
    ApolloServerPluginDrainHttpServer({ httpServer }),
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          }
        };
      }
    },
    ApolloServerPluginLandingPageGraphQLPlayground({
      settings: {
        'request.credentials': 'include',
        'subscriptions.endpoint': `ws://localhost:${PORT}/graphql`
      }
    })
  ],
  introspection: NODE_ENV !== 'production',

  formatError: (formattedError, error) => {

    if (NODE_ENV === 'production') {
      if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR' || formattedError.message.includes('Internal server error')) {
        return {
          message: 'An unexpected internal error occurred.',
          extensions: { code: 'INTERNAL_SERVER_ERROR' }
        };
      }
    }
    return formattedError;
  }
});

async function startServer() {
  try {

    await redisClient.connect();

    await connectMongoDB();

    await createIndexes();

    await apolloServer.start();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cors(corsOptions));
    app.use(sessionMiddleware);

    app.use(
      '/graphql',
      expressMiddleware(apolloServer, {
        context: async ({ req, res }) => {
          const context = await buildContext({ req, res });
          return {
            ...context,
            pubsub,
            redisClient,
            messageLoader: createMessageLoader()
          };
        }
      })
    );

    app.get('/health', async (req, res) => {
      const mongoose = require('mongoose');
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        redis: redisClient.isOpen ? 'connected' : 'disconnected',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        pubsub: (typeof pubsub.asyncIterator === 'function' && typeof pubsub.publish === 'function') ? 'initialized' : 'error'
      });
    });

    app.get('/', (req, res) => {
      res.redirect('/graphql');
    });

    httpServer.listen(PORT, () => {
    });

  } catch (error) {
    process.exit(1);
  }
}

async function shutdown(signal) {

  try {
    await apolloServer.stop();

    await serverCleanup.dispose();

    await new Promise((resolve) => httpServer.close(resolve));

    await redisClient.disconnect();

    await closeMongoConnection();

    await closePool();

    process.exit(0);

  } catch (error) {
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  shutdown('unhandledRejection');
});

startServer();