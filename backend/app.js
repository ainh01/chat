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

// ============================================================  
// DEBUG LOGGERS - Namespaced for selective enabling  
// ============================================================  
const debug = require('debug');  
const debugRedis = debug('app:redis');  
const debugWebSocket = debug('app:websocket');  
const debugApollo = debug('app:apollo');  
const debugDatabase = debug('app:database');  
const debugSession = debug('app:session');  
const debugServer = debug('app:server');  
const debugError = debug('app:error');  

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
const { createIndexes } = require('./src/db/nosql/indexes.js');  

const { createMessageLoader } = require('./src/loaders/messageLoader.js');  

dotenv.config();  

const PORT = process.env.PORT || 4000;  
const REDIS_URL = process.env.REDIS_URL;  
const SESSION_SECRET = process.env.SESSION_SECRET;  
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 604800000;  
const NODE_ENV = process.env.NODE_ENV || 'development';  
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';  

debugServer('Environment: %s', NODE_ENV);  
debugServer('Port: %d', PORT);  

if (REDIS_URL) {  
  try {  
    const redisUrlObj = new URL(REDIS_URL);  
    debugRedis('Redis configuration: host=%s, port=%s, protocol=%s, TLS=%s',  
      redisUrlObj.hostname,  
      redisUrlObj.port || '6379',  
      redisUrlObj.protocol.replace(':', ''),  
      redisUrlObj.protocol === 'rediss:' ? 'enabled' : 'disabled'  
    );  
  } catch (err) {  
    debugError('Invalid REDIS_URL format: %s', err.message);  
  }  
} else {  
  debugError('REDIS_URL is not defined');  
}  

if (!REDIS_URL) {  
  debugError('REDIS_URL is not defined in environment variables');  
  debugError('Application cannot start without Redis connection URL');  
  process.exit(1);  
}  

if (!REDIS_URL.startsWith('rediss://') && !REDIS_URL.startsWith('redis://')) {  
  debugError('REDIS_URL must start with redis:// or rediss:// protocol');  
  process.exit(1);  
}  

if (!SESSION_SECRET) {  
  debugError('SESSION_SECRET is not defined in environment variables');  
  debugError('Application cannot start without session secret');  
  process.exit(1);  
}  

if (!pubsub) {  
  debugError('PubSub module failed to initialize');  
  process.exit(1);  
}  
if (typeof pubsub.asyncIterator !== 'function' || typeof pubsub.publish !== 'function') {  
  debugError('PubSub interface validation failed - missing required methods');  
  process.exit(1);  
}  

debugServer('PubSub initialized successfully');  

const app = express();  
const httpServer = http.createServer(app);  

// ============================================================  
// REDIS CLIENT CONFIGURATION WITH DEBUG LOGGING  
// ============================================================  
const redisClient = createClient({  
  url: REDIS_URL,  
  socket: {  
    reconnectStrategy: (retries) => {  
      debugRedis('Reconnection attempt #%d', retries);  

      if (retries > 10) {  
        debugError('Redis max reconnection attempts exceeded (10)');  
        return new Error('Redis connection failed');  
      }  

      const delay = Math.min(retries * 100, 3000);  
      debugRedis('Reconnecting in %dms', delay);  
      return delay;  
    }  
  }  
});  

redisClient.on('error', (err) => {  
  debugRedis('Redis client error: %s', err.message);  
  debugError('Redis error: %O', {  
    message: err.message,  
    code: err.code,  
    stack: err.stack  
  });  
});  

redisClient.on('connect', () => {  
  const redisUrlObj = new URL(REDIS_URL);  
  debugRedis('Redis client connecting to %s:%s (TLS: %s)',  
    redisUrlObj.hostname,  
    redisUrlObj.port || '6379',  
    redisUrlObj.protocol === 'rediss:' ? 'enabled' : 'disabled'  
  );  
});  

redisClient.on('ready', () => {  
  debugRedis('Redis client ready - connection established successfully');  
  debugRedis('Redis store prefix: sess:, TTL: %ds', SESSION_MAX_AGE / 1000);  
});  

redisClient.on('reconnecting', () => {  
  debugRedis('Redis client reconnecting...');  
});  

const redisStore = new RedisStore({  
  client: redisClient,  
  prefix: 'sess:',  
  ttl: SESSION_MAX_AGE / 1000  
});  

debugSession('RedisStore configured with TTL: %ds', SESSION_MAX_AGE / 1000);  

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

debugSession('Session middleware configured: httpOnly=%s, secure=%s, sameSite=lax, maxAge=%dms',  
  true, NODE_ENV === 'production', SESSION_MAX_AGE);  

const corsOptions = {  
  origin: NODE_ENV === 'production' ? FRONTEND_URL : 'http://localhost:5500',  
  credentials: true,  
  methods: ['GET', 'POST', 'OPTIONS'],  
  allowedHeaders: ['Content-Type', 'Authorization']  
};  

debugServer('CORS configured for origin: %s', corsOptions.origin);  

const schema = makeExecutableSchema({  
  typeDefs: [userTypeDefs, conversationTypeDefs, friendTypeDefs, callTypeDefs],  
  resolvers: [userResolvers, conversationResolvers, friendResolvers, callResolvers]  
});  

debugApollo('GraphQL schema created with 4 type definition modules');  

// ============================================================  
// WEBSOCKET SESSION AUTHENTICATION WITH DEBUG LOGGING  
// ============================================================  
async function getSessionFromWebSocket(ctx) {  
  const cookieHeader = ctx.extra?.request?.headers?.cookie;  

  if (!cookieHeader) {  
    debugSession('WebSocket connection attempt without cookies');  
    return { user: null };  
  }  

  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {  
    const [key, value] = cookie.trim().split('=');  
    acc[key] = decodeURIComponent(value);  
    return acc;  
  }, {});  

  const sessionId = cookies['connect.sid'];  

  if (!sessionId) {  
    debugSession('WebSocket connection missing connect.sid cookie');  
    return { user: null };  
  }  

  const unsignedSessionId = sessionId.startsWith('s:')  
    ? sessionId.slice(2).split('.')[0]  
    : sessionId;  

  debugSession('Retrieving session for WebSocket: %s', unsignedSessionId.substring(0, 8) + '...');  

  return new Promise((resolve) => {  
    redisStore.get(unsignedSessionId, async (err, session) => {  
      if (err) {  
        debugError('Session retrieval error for WebSocket: %s', err.message);  
        return resolve({ user: null });  
      }  
      if (!session || !session.userId) {  
        debugSession('WebSocket session not found or missing userId');  
        return resolve({ user: null });  
      }  

      try {  
        const { findUserById } = require('./src/models/UserCore.js');  
        const user = await findUserById(session.userId);  

        if (user) {  
          debugSession('WebSocket authenticated: userId=%s, username=%s',  
            user.id, user.username || 'N/A');  
        } else {  
          debugSession('WebSocket session userId=%s not found in database', session.userId);  
        }  

        resolve({ user });  
      } catch (error) {  
        debugError('Error fetching user for WebSocket session: %s', error.message);  
        resolve({ user: null });  
      }  
    });  
  });  
}  

// ============================================================  
// WEBSOCKET SERVER CONFIGURATION WITH DEBUG LOGGING  
// ============================================================  
const wsServer = new WebSocketServer({  
  server: httpServer,  
  path: '/graphql',  
  handleProtocols: (protocols) => {  
    debugWebSocket('Client protocol negotiation: %O', protocols);  

    if (protocols.includes('graphql-transport-ws')) {  
      debugWebSocket('Selected protocol: graphql-transport-ws');  
      return 'graphql-transport-ws';  
    }  
    if (protocols.includes('graphql-ws')) {  
      debugWebSocket('Selected protocol: graphql-ws');  
      return 'graphql-ws';  
    }  

    debugWebSocket('No supported protocol found');  
    return false;  
  }  
});  

debugWebSocket('WebSocket server created on path: /graphql');  

const serverCleanup = useServer({  
  schema,  
  onConnect: async (ctx) => {  
    const clientIp = ctx.extra?.request?.socket?.remoteAddress || 'unknown';  
    debugWebSocket('New WebSocket connection from IP: %s', clientIp);  

    const { user } = await getSessionFromWebSocket(ctx);  

    if (user) {  
      ctx.extra.user = user;  
      debugWebSocket('WebSocket authenticated: userId=%s', user.id);  
    } else {  
      debugWebSocket('WebSocket connection unauthenticated');  
    }  

    return true;  
  },  

  context: async (ctx) => {  
    const user = ctx.extra?.user || null;  

    debugWebSocket('Creating WebSocket context: authenticated=%s', !!user);  

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

    debugWebSocket('Subscription started: operation=%s, userId=%s, subscriptionId=%s',  
      operationName,  
      user ? user.id : 'anonymous',  
      msg.id || 'N/A'  
    );  

    debugWebSocket('Subscription query preview: %s',  
      query.substring(0, 100).replace(/\s+/g, ' ')  
    );  
  },  

  onComplete: (ctx, msg) => {  
    const user = ctx.extra?.user;  
    const subscriptionId = msg.id || 'N/A';  

    debugWebSocket('Subscription completed: subscriptionId=%s, userId=%s',  
      subscriptionId,  
      user ? user.id : 'anonymous'  
    );  
  },  

  onError: (ctx, msg, errors) => {  
    const user = ctx.extra?.user;  
    const operationName = msg?.payload?.operationName || 'Unknown';  

    debugError('WebSocket subscription error: operation=%s, userId=%s, errorCount=%d',  
      operationName,  
      user ? user.id : 'anonymous',  
      errors.length  
    );  

    errors.forEach((error, index) => {  
      debugError('Subscription error #%d: %s', index + 1, error.message);  
      if (error.stack) {  
        debugError('Stack trace: %s', error.stack);  
      }  
    });  
  }  
}, wsServer);  

wsServer.on('connection', (ws, request) => {  
  const clientIp = request.socket.remoteAddress;  
  const url = request.url;  

  debugWebSocket('WebSocket connection established: ip=%s, url=%s', clientIp, url);  
  debugWebSocket('Active connections: %d', wsServer.clients.size);  

  ws.on('close', (code, reason) => {  
    debugWebSocket('WebSocket client disconnected: ip=%s, code=%d, reason=%s',  
      clientIp,  
      code,  
      reason.toString() || 'none'  
    );  
    debugWebSocket('Active connections: %d', wsServer.clients.size);  
  });  
});  

wsServer.on('error', (error) => {  
  debugError('WebSocket server error: %s', error.message);  
  debugError('WebSocket error details: %O', {  
    message: error.message,  
    code: error.code,  
    stack: error.stack  
  });  
});  

wsServer.on('close', () => {  
  debugWebSocket('WebSocket server closed');  
});  

// ============================================================  
// APOLLO SERVER CONFIGURATION WITH DEBUG LOGGING  
// ============================================================  
const apolloServer = new ApolloServer({  
  schema,  
  plugins: [  
    ApolloServerPluginDrainHttpServer({ httpServer }),  
    {  
      async serverWillStart() {  
        debugApollo('Apollo Server starting...');  
        return {  
          async drainServer() {  
            debugApollo('Draining Apollo Server connections...');  
            await serverCleanup.dispose();  
            debugApollo('WebSocket server cleanup completed');  
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
    debugError('GraphQL error: %s', formattedError.message);  
    debugError('Error code: %s', formattedError.extensions?.code || 'N/A');  

    if (formattedError.path) {  
      debugError('Error path: %O', formattedError.path);  
    }  

    if (error.originalError) {  
      debugError('Original error: %s', error.originalError.message);  
      debugError('Stack trace: %s', error.originalError.stack);  
    }  

    if (NODE_ENV === 'production') {  
      if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR' ||  
          formattedError.message.includes('Internal server error')) {  
        debugError('Sanitizing internal error for production response');  
        return {  
          message: 'An unexpected internal error occurred.',  
          extensions: { code: 'INTERNAL_SERVER_ERROR' }  
        };  
      }  
    }  
    return formattedError;  
  }  
});  

debugApollo('Apollo Server configured: introspection=%s, playground=%s',  
  NODE_ENV !== 'production',  
  true  
);  

// ============================================================  
// SERVER STARTUP WITH DEBUG LOGGING  
// ============================================================  
async function startServer() {  
  const startTime = Date.now();  
  debugServer('Starting server initialization...');  

  try {  
    // Redis connection  
    debugRedis('Connecting to Redis...');  
    await redisClient.connect();  
    debugRedis('Redis connected successfully');  

    // MongoDB connection  
    debugDatabase('Connecting to MongoDB...');  
    await connectMongoDB();  
    debugDatabase('MongoDB connected successfully');  

    // Create indexes  
    debugDatabase('Creating MongoDB indexes...');  
    await createIndexes();  
    debugDatabase('MongoDB indexes created successfully');  

    // Apollo Server startup  
    debugApollo('Starting Apollo Server...');  
    await apolloServer.start();  
    debugApollo('Apollo Server started successfully');  

    // Express middleware setup  
    debugServer('Configuring Express middleware...');  
    app.use(express.json());  
    app.use(express.urlencoded({ extended: true }));  
    app.use(cors(corsOptions));  
    app.use(sessionMiddleware);  
    debugServer('Express middleware configured');  

    // GraphQL endpoint  
    debugApollo('Mounting GraphQL endpoint at /graphql');  
    app.use(  
      '/graphql',  
      expressMiddleware(apolloServer, {  
        context: async ({ req, res }) => {  
          const userId = req.session?.userId;  

          if (userId) {  
            debugSession('GraphQL request with session: userId=%s', userId);  
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

    // Health check endpoint  
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

      debugServer('Health check: %O', healthData);  
      res.json(healthData);  
    });  

    app.get('/', (req, res) => {  
      debugServer('Root endpoint accessed, redirecting to /graphql');  
      res.redirect('/graphql');  
    });  

    // Start HTTP server  
    httpServer.listen(PORT, () => {  
      const elapsedTime = Date.now() - startTime;  

      debugServer('═══════════════════════════════════════════════════');  
      debugServer('🚀 Server started successfully in %dms', elapsedTime);  
      debugServer('═══════════════════════════════════════════════════');  
      debugServer('Environment: %s', NODE_ENV);  
      debugServer('Port: %d', PORT);  
      debugServer('GraphQL Endpoint: http://localhost:%d/graphql', PORT);  
      debugServer('WebSocket Endpoint: ws://localhost:%d/graphql', PORT);  
      debugServer('Health Check: http://localhost:%d/health', PORT);  
      debugServer('═══════════════════════════════════════════════════');  

      console.log(`🚀 Server ready at http://localhost:${PORT}/graphql`);  
      console.log(`🔌 WebSocket ready at ws://localhost:${PORT}/graphql`);  
      console.log(`💚 Health check at http://localhost:${PORT}/health`);  
    });  

  } catch (error) {  
    debugError('Server startup failed: %s', error.message);  
    debugError('Error stack: %s', error.stack);  
    debugError('Fatal error during initialization - exiting process');  

    console.error('❌ Server startup failed:', error.message);  
    process.exit(1);  
  }  
}  

// ============================================================  
// GRACEFUL SHUTDOWN WITH DEBUG LOGGING  
// ============================================================  
async function shutdown(signal) {  
  debugServer('Received %s signal - initiating graceful shutdown', signal);  
  debugServer('═══════════════════════════════════════════════════');  

  const shutdownStart = Date.now();  

  try {  
    // Stop Apollo Server  
    debugApollo('Stopping Apollo Server...');  
    await apolloServer.stop();  
    debugApollo('Apollo Server stopped');  

    // Cleanup WebSocket server  
    debugWebSocket('Disposing WebSocket server...');  
    await serverCleanup.dispose();  
    debugWebSocket('WebSocket server disposed, active connections: 0');  

    // Close HTTP server  
    debugServer('Closing HTTP server...');  
    await new Promise((resolve) => httpServer.close(resolve));  
    debugServer('HTTP server closed');  

    // Disconnect Redis  
    debugRedis('Disconnecting Redis client...');  
    await redisClient.disconnect();  
    debugRedis('Redis disconnected');  

    // Close MongoDB  
    debugDatabase('Closing MongoDB connection...');  
    await closeMongoConnection();  
    debugDatabase('MongoDB connection closed');  

    // Close SQL pool  
    debugDatabase('Closing SQL connection pool...');  
    await closePool();  
    debugDatabase('SQL connection pool closed');  

    const shutdownTime = Date.now() - shutdownStart;  
    debugServer('═══════════════════════════════════════════════════');  
    debugServer('✅ Graceful shutdown completed in %dms', shutdownTime);  
    debugServer('═══════════════════════════════════════════════════');  

    process.exit(0);  

  } catch (error) {  
    debugError('Error during shutdown: %s', error.message);  
    debugError('Shutdown error stack: %s', error.stack);  
    debugError('Forcing process exit due to shutdown error');  

    console.error('❌ Shutdown error:', error.message);  
    process.exit(1);  
  }  
}  

// ============================================================  
// PROCESS EVENT HANDLERS WITH DEBUG LOGGING  
// ============================================================  
process.on('SIGINT', () => {  
  debugServer('SIGINT received (Ctrl+C)');  
  shutdown('SIGINT');  
});  

process.on('SIGTERM', () => {  
  debugServer('SIGTERM received');  
  shutdown('SIGTERM');  
});  

process.on('uncaughtException', (error) => {  
  debugError('Uncaught Exception: %s', error.message);  
  debugError('Exception stack: %s', error.stack);  
  debugError('Process state may be corrupted - initiating shutdown');  

  console.error('❌ Uncaught Exception:', error);  
  shutdown('uncaughtException');  
});  

process.on('unhandledRejection', (reason, promise) => {  
  debugError('Unhandled Promise Rejection at: %O', promise);  
  debugError('Rejection reason: %s', reason);  

  if (reason && reason.stack) {  
    debugError('Rejection stack: %s', reason.stack);  
  }  

  console.error('❌ Unhandled Rejection:', reason);  
  shutdown('unhandledRejection');  
});  

debugServer('Process event handlers registered');  

// Start the server  
startServer();  