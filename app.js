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

const pubsubModule = require('./src/pubsub/events.js');

const pubsub = pubsubModule.pubsub;

const { buildContext } = require('./src/middleware/auth.js');
const { closePool } = require('./src/db/sql/db.js');
const { connectMongoDB, closeMongoConnection } = require('./src/db/nosql/db.js');
const { createIndexes } = require('./src/db/nosql/indexes.js');

dotenv.config();

const PORT = process.env.PORT || 4000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 604800000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

if (!SESSION_SECRET) {
  console.error('SESSION_SECRET not set in environment.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

if (!pubsub) {
  console.error('PubSub instance is undefined after import.');
  process.exit(1);
}
if (typeof pubsub.asyncIterator !== 'function' || typeof pubsub.publish !== 'function') {
  console.error('PubSub instance is invalid or not properly initialized.');
  console.error(`- Type of pubsub: ${typeof pubsub}`);
  console.error(`- Has asyncIterator: ${typeof pubsub.asyncIterator === 'function'}`);
  console.error(`- Has publish: ${typeof pubsub.publish === 'function'}`);
  console.error('Check ./src/pubsub/events.js exports.');
  process.exit(1);
}
console.log('PubSub instance validated.');

const app = express();
const httpServer = http.createServer(app);

const redisClient = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('Redis reconnection failed after 10 attempts');
        return new Error('Redis connection failed');
      }
      const delay = Math.min(retries * 100, 3000);
      console.log(`Redis reconnecting in ${delay}ms (attempt ${retries})`);
      return delay;
    }
  }
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis client connecting...'));
redisClient.on('ready', () => console.log('Redis client connected and ready'));
redisClient.on('reconnecting', () => console.log('Redis client reconnecting...'));

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
  typeDefs: [userTypeDefs, conversationTypeDefs],
  resolvers: [userResolvers, conversationResolvers]
});

async function getSessionFromWebSocket(ctx) {
  const cookieHeader = ctx.extra?.request?.headers?.cookie;

  if (!cookieHeader) {
    console.log('No cookies found in WebSocket request.');
    return { user: null };
  }

  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split('=');
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});

  const sessionId = cookies['connect.sid'];

  if (!sessionId) {
    console.log('No connect.sid cookie found.');
    return { user: null };
  }

  const unsignedSessionId = sessionId.startsWith('s:')
    ? sessionId.slice(2).split('.')[0]
    : sessionId;

  return new Promise((resolve) => {
    redisStore.get(unsignedSessionId, async (err, session) => {
      if (err) {
        console.error('Error retrieving session from Redis:', err);
        return resolve({ user: null });
      }
      if (!session || !session.userId) {
        console.log('Session not found or no userId in session.');
        return resolve({ user: null });
      }

      try {
        const { findUserById } = require('./src/models/UserCore.js');
        const user = await findUserById(session.userId);
        resolve({ user });
      } catch (error) {
        console.error('Error loading user in WebSocket context:', error);
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
    console.log('WebSocket connection initiated.');

    const { user } = await getSessionFromWebSocket(ctx);

    if (user) {
      console.log(`WebSocket authenticated: ${user.username} (ID: ${user.id})`);
      ctx.extra.user = user;
    } else {
      console.log('WebSocket connected without authentication. Subscriptions requiring auth will fail.');
    }
    return true;
  },

  context: async (ctx) => {
    const user = ctx.extra?.user || null;

    return {
      user,
      pubsub,
      redisClient
    };
  },

  onSubscribe: (ctx, msg) => {
    const query = msg.payload?.query || msg.query || 'Unknown Subscription Query';
    const operationName = msg.payload?.operationName || 'N/A';
    console.log(`Subscription started: Operation "${operationName}"`);
    console.log(`Query preview: ${query.substring(0, 60).replace(/\n/g, ' ')}...`);
  },

  onComplete: (ctx, msg) => {
    console.log('Subscription completed.');
  },

  onError: (ctx, msg, errors) => {
    console.error('WebSocket Subscription Error:', errors);
  }
}, wsServer);

wsServer.on('connection', (ws, request) => {
  console.log('Raw WebSocket connection established.');
  console.log(' - URL:', request.url);
  console.log(' - Origin:', request.headers.origin);
  console.log(' - Protocols:', request.headers['sec-websocket-protocol']);
  console.log(' - Cookies:', request.headers.cookie ? 'Present' : 'Missing');
});
wsServer.on('error', (error) => console.error('WebSocket Server Error:', error));
wsServer.on('close', () => console.log('WebSocket server closed.'));

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
    console.error('GraphQL Error Details:', error);

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
    console.log('Starting GraphQL Authentication + Chat Server...\n');

    console.log('Connecting to Redis...');
    await redisClient.connect();

    console.log('Connecting to MongoDB...');
    await connectMongoDB();

    console.log('Creating MongoDB indexes...');
    await createIndexes();

    console.log('Initializing Apollo Server...');
    await apolloServer.start();

    console.log('Configuring Express middleware...\n');

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
            redisClient
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
      console.log('Server started successfully!\n');
      console.log('Server Information:');
      console.log(`- GraphQL HTTP: http://localhost:${PORT}/graphql`);
      console.log(`- GraphQL WebSocket: ws://localhost:${PORT}/graphql`);
      console.log(`- GraphQL Playground: http://localhost:${PORT}/graphql`);
      console.log(`- Health Check: http://localhost:${PORT}/health`);
      console.log(`- Environment: ${NODE_ENV}`);
      console.log(`- Redis: ${REDIS_HOST}:${REDIS_PORT}`);
      console.log(`- MongoDB: ${process.env.MONGODB_URI ? 'Configured' : 'Not configured'}`);
      console.log(`- Session Duration: ${SESSION_MAX_AGE / 1000 / 60 / 60 / 24} days\n`);

      console.log('Security Configuration:');
      console.log(`- HttpOnly Cookies: `);
      console.log(`- Secure Cookies: ${NODE_ENV === 'production' ? '' : '(disabled in dev)'}`);
      console.log(`- SameSite Policy: Lax`);
      console.log(`- WebSocket Auth: Cookie-based`);
      console.log(`- Bcrypt Salt Rounds: 12`);
      console.log(`- Session Store: Redis`);
      console.log(`- CORS Origin: ${corsOptions.origin}\n`);

      console.log('Chat Features (Phase 1):');
      console.log('Create 1-on-1 conversations');
      console.log('Send real-time messages');
      console.log('Cursor-based pagination');
      console.log('WebSocket subscriptions\n');

      console.log('Quick Start Guide:');
      console.log('1. Open http://localhost:4000/graphql in your browser');
      console.log('2. Enable "Request Credentials" in Playground settings');
      console.log('3. Run login mutation to authenticate');
      console.log('4. Run createConversation to start chat');
      console.log('5. Open subscription tab and subscribe to messageReceived');
      console.log('6. Run sendMessage to test real-time delivery\n');
    });

  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  try {
    await apolloServer.stop();
    console.log('Apollo Server stopped.');

    await serverCleanup.dispose();
    console.log('WebSocket server closed.');

    await new Promise((resolve) => httpServer.close(resolve));
    console.log('HTTP server closed.');

    await redisClient.disconnect();
    console.log('Redis disconnected.');

    await closeMongoConnection();
    console.log('MongoDB disconnected.');

    await closePool();
    console.log('SQL Server pool closed.');

    console.log('Shutdown complete. Exiting process.');
    process.exit(0);

  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

startServer();