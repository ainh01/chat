const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { ApolloServerPluginLandingPageGraphQLPlayground } = require('@apollo/server-plugin-landing-page-graphql-playground');
const cors = require('cors');
const dotenv = require('dotenv');

const { typeDefs } = require('./src/graphql/schemas/userSchema.js');
const { resolvers } = require('./src/graphql/resolvers/userResolver.js');
const { buildContext } = require('./src/middleware/auth.js');
const { closePool } = require('./src/db/sql/db.js');

dotenv.config();

const PORT = process.env.PORT || 4000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 604800000;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!SESSION_SECRET) {
  console.error('❌ FATAL: SESSION_SECRET not set in environment');
  console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const app = express();

const redisClient = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('❌ Redis reconnection failed after 10 attempts');
        return new Error('Redis connection failed');
      }
      const delay = Math.min(retries * 100, 3000);
      console.log(`⚠️  Redis reconnecting in ${delay}ms (attempt ${retries})`);
      return delay;
    }
  }
});

redisClient.on('error', (err) => {
  console.error('❌ Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('🔄 Redis client connecting...');
});

redisClient.on('ready', () => {
  console.log('✅ Redis client connected and ready');
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis client reconnecting...');
});

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
  origin: NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL || 'https://yourdomain.com'
    : 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [
    ApolloServerPluginLandingPageGraphQLPlayground({
      settings: {
        'request.credentials': 'include'
      }
    })
  ],
  introspection: NODE_ENV !== 'production',
  
  formatError: (formattedError, error) => {
    console.error('GraphQL Error:', formattedError);
    
    if (NODE_ENV === 'production') {
      if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        return {
          message: 'An internal error occurred',
          extensions: { code: 'INTERNAL_SERVER_ERROR' }
        };
      }
    }
    
    return formattedError;
  }
});

async function startServer() {
  try {
    console.log('🚀 Starting GraphQL Authentication Server...\n');
    
    console.log('📡 Connecting to Redis...');
    await redisClient.connect();
    
    console.log('🔧 Initializing Apollo Server...');
    await apolloServer.start();
    
    console.log('⚙️  Configuring Express middleware...\n');
    
    // Apply middleware in correct order - GLOBALLY
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cors(corsOptions));
    app.use(sessionMiddleware);
    
    // GraphQL endpoint - NO redundant middleware
    app.use(
      '/graphql',
      expressMiddleware(apolloServer, {
        context: buildContext
      })
    );

    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        redis: redisClient.isOpen ? 'connected' : 'disconnected'
      });
    });
    
    app.get('/', (req, res) => {
      res.redirect('/graphql');
    });
    
    app.listen(PORT, () => {
      console.log('✅ Server started successfully!\n');
      console.log('📍 Server Information:');
      console.log(`   - GraphQL Endpoint: http://localhost:${PORT}/graphql`);
      console.log(`   - GraphQL Playground: http://localhost:${PORT}/graphql`);
      console.log(`   - Health Check: http://localhost:${PORT}/health`);
      console.log(`   - Environment: ${NODE_ENV}`);
      console.log(`   - Redis: ${REDIS_HOST}:${REDIS_PORT}`);
      console.log(`   - Session Duration: ${SESSION_MAX_AGE / 1000 / 60 / 60 / 24} days\n`);
      
      console.log('🔐 Security Configuration:');
      console.log(`   - HttpOnly Cookies: ✅`);
      console.log(`   - Secure Cookies: ${NODE_ENV === 'production' ? '✅' : '⚠️  (disabled in dev)'}`);
      console.log(`   - SameSite Policy: Lax`);
      console.log(`   - Bcrypt Salt Rounds: 12`);
      console.log(`   - Session Store: Redis`);
      console.log(`   - CORS Origin: ${corsOptions.origin}\n`);
      
      console.log('📖 Quick Start Guide:');
      console.log('   1. Open http://localhost:4000/graphql in your browser');
      console.log('   2. Enable "Request Credentials" in Playground settings');
      console.log('   3. Run register mutation to create account');
      console.log('   4. Run login mutation to authenticate');
      console.log('   5. Run me query to access protected data');
      console.log('   6. Run logout mutation to end session\n');
    });
    
  } catch (error) {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n📴 Received ${signal}, shutting down gracefully...`);
  
  try {
    await apolloServer.stop();
    console.log('✅ Apollo Server stopped');
    
    await redisClient.disconnect();
    console.log('✅ Redis disconnected');
    
    await closePool();
    console.log('✅ SQL Server pool closed');
    
    console.log('👋 Shutdown complete');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

startServer();
