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

const { typeDefs: callTypeDefs } = require('./src/graphql/schemas/callSchema.js');
const { resolvers: callResolvers } = require('./src/graphql/resolvers/callResolver.js');

const pubsubModule = require('./src/pubsub/events.js');

const pubsub = pubsubModule.pubsub;

const { buildContext } = require('./src/middleware/auth.js');
const { closePool } = require('./src/db/sql/db.js');
const { connectMongoDB, closeMongoConnection } = require('./src/db/nosql/db.js');

const { createMessageLoader } = require('./src/loaders/messageLoader.js');

dotenv.config();

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 604800000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

if (REDIS_URL) {
  try {
    const redisUrlObj = new URL(REDIS_URL);
  } catch (err) {
  }
} else {
}

if (!REDIS_URL) {
  process.exit(1);
}

if (!REDIS_URL.startsWith('rediss://') && !REDIS_URL.startsWith('redis://')) {
  process.exit(1);
}

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
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        return new Error('Redis connection failed');
      }

      const delay = Math.min(retries * 100, 3000);
      return delay;
    }
  }
});

redisClient.on('error', (err) => {
});

redisClient.on('connect', () => {
  const redisUrlObj = new URL(REDIS_URL);
});

redisClient.on('ready', () => {
});

redisClient.on('reconnecting', () => {
});

const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'sess:',
  ttl: SESSION_MAX_AGE / 1000
});

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  BACKEND_URL,
  'https://chat.xain.click',
  'https://twchat.xain.click',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000'
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

if (ALLOWED_ORIGINS.length === 0) {
  process.exit(1);
}

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Apollo-Require-Preflight'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400
};

const sessionMiddleware = session({
  store: redisStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE,
    domain: NODE_ENV === 'production' ? undefined : undefined,
    path: '/'
  },
  name: 'connect.sid',
  proxy: NODE_ENV === 'production'
});

const schema = makeExecutableSchema({
  typeDefs: [userTypeDefs, conversationTypeDefs, friendTypeDefs, callTypeDefs],
  resolvers: [userResolvers, conversationResolvers, friendResolvers, callResolvers]
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

        if (user) {
        } else {
        }

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
  verifyClient: (info, callback) => {
    const origin = info.origin || info.req.headers.origin;

    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(true);
    } else {
      callback(false, 403, 'Forbidden');
    }
  },
  handleProtocols: (protocols) => {
    if (protocols.includes('graphql-transport-ws')) {
      return 'graphql-transport-ws';
    }
    if (protocols.includes('graphql-ws')) {
      return 'graphql-ws';
    }

    return false;
  }
});

const serverCleanup = useServer({
  schema,
  onConnect: async (ctx) => {
    const clientIp = ctx.extra?.request?.socket?.remoteAddress || 'unknown';

    const { user } = await getSessionFromWebSocket(ctx);

    if (user) {
      ctx.extra.user = user;
    } else {
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
    const user = ctx.extra?.user;
  },

  onComplete: (ctx, msg) => {
    const user = ctx.extra?.user;
    const subscriptionId = msg.id || 'N/A';
  },

  onError: (ctx, msg, errors) => {
    const user = ctx.extra?.user;
    const operationName = msg?.payload?.operationName || 'Unknown';

    errors.forEach((error, index) => {
      if (error.stack) {
      }
    });
  }
}, wsServer);

wsServer.on('connection', (ws, request) => {
  const clientIp = request.socket.remoteAddress;
  const url = request.url;

  ws.on('close', (code, reason) => {
  });
});

wsServer.on('error', (error) => {
});

wsServer.on('close', () => {
});

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
        'subscriptions.endpoint': NODE_ENV === 'production'
          ? `wss://${new URL(FRONTEND_URL).hostname}/graphql`
          : `ws://localhost:${PORT}/graphql`
      }
    })
  ],
  introspection: NODE_ENV !== 'production',

  formatError: (formattedError, error) => {
    if (formattedError.path) {
    }

    if (error.originalError) {
    }

    if (NODE_ENV === 'production') {
      if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR' ||
        formattedError.message.includes('Internal server error')) {
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
  const startTime = Date.now();

  try {
    await redisClient.connect();

    await connectMongoDB();

    await apolloServer.start();

    app.use(cors(corsOptions));
    app.use(sessionMiddleware);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const origin = req.headers.origin || req.headers.referer || 'no-origin';

      const originalSend = res.send;
      res.send = function (data) {
        originalSend.call(this, data);
      };

      next();
    });

    app.use(
      '/graphql',
      expressMiddleware(apolloServer, {
        context: async ({ req, res }) => {
          const userId = req.session?.userId;

          if (userId) {
          }

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

      const healthData = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        redis: redisClient.isOpen ? 'connected' : 'disconnected',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        pubsub: (typeof pubsub.asyncIterator === 'function' && typeof pubsub.publish === 'function') ? 'initialized' : 'error'
      };

      res.json(healthData);
    });

    app.get('/', (req, res) => {
      res.redirect('/graphql');
    });

    httpServer.listen(PORT, () => {
      const elapsedTime = Date.now() - startTime;

      console.log(`Server ready at http://localhost:${PORT}/graphql`);
      console.log(`WebSocket ready at ws://localhost:${PORT}/graphql`);
      console.log(`Health check at http://localhost:${PORT}/health`);
    });

  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  const shutdownStart = Date.now();

  try {
    await apolloServer.stop();

    await serverCleanup.dispose();

    await new Promise((resolve) => httpServer.close(resolve));

    await redisClient.disconnect();

    await closeMongoConnection();

    await closePool();

    const shutdownTime = Date.now() - shutdownStart;

    process.exit(0);

  } catch (error) {
    console.error('Shutdown error:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.stack) {
  }

  console.error('Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});

startServer();