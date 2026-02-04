const mongoose = require('mongoose');

let isConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 1000;

async function connectMongoDB() {
  if (isConnected && mongoose.connection.readyState === 1) {
    console.log('MongoDB already connected (reusing existing connection)');
    return mongoose.connection;
  }

  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI not defined in environment variables.\n' +
      '   Add to .env: MONGODB_URI=mongodb://localhost:27017/todoDB'
    );
  }

  if (!MONGODB_URI.includes('mongodb://') && !MONGODB_URI.includes('mongodb+srv://')) {
    throw new Error(
      'Invalid MONGODB_URI format.\n' +
      '   Expected: mongodb://host:port/database or mongodb+srv://host/database'
    );
  }

  const options = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4
  };

  const attemptConnection = async (attempt = 1) => {
    try {
      console.log(`Connecting to MongoDB (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})...`);
      await mongoose.connect(MONGODB_URI, options);

      isConnected = true;
      connectionAttempts = 0;

      console.log('MongoDB connected successfully');
      console.log(`   Database: ${mongoose.connection.name}`);
      console.log(`   Host: ${mongoose.connection.host}:${mongoose.connection.port}`);

      return mongoose.connection;

    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt} failed:`, error.message);

      if (attempt >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Failed to connect to MongoDB after ${MAX_RETRY_ATTEMPTS} attempts.\n` +
          `Last error: ${error.message}`
        );
      }

      const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`Retrying in ${delay}ms...`);

      await new Promise(resolve => setTimeout(resolve, delay));
      return attemptConnection(attempt + 1);
    }
  };

  return attemptConnection();
}

async function closeMongoConnection() {
  if (!isConnected) {
    console.log('MongoDB not connected, skipping disconnect');
    return;
  }

  try {
    await mongoose.connection.close();
    isConnected = false;
    console.log('MongoDB connection closed gracefully');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    throw error;
  }
}

mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error:', err);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected from MongoDB');
  isConnected = false;
});

process.on('SIGINT', async () => {
  await closeMongoConnection();
  process.exit(0);
});

module.exports = {
  connectMongoDB,
  closeMongoConnection
};