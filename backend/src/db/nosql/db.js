const mongoose = require('mongoose');

let isConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 1000;

async function connectMongoDB() {
  if (isConnected && mongoose.connection.readyState === 1) {
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
      await mongoose.connect(MONGODB_URI, options);

      isConnected = true;
      connectionAttempts = 0;

      return mongoose.connection;

    } catch (error) {
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        throw new Error(
          `Failed to connect to MongoDB after ${MAX_RETRY_ATTEMPTS} attempts.\n` +
          `Last error: ${error.message}`
        );
      }

      const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);

      await new Promise(resolve => setTimeout(resolve, delay));
      return attemptConnection(attempt + 1);
    }
  };

  return attemptConnection();
}

async function closeMongoConnection() {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.connection.close();
    isConnected = false;
  } catch (error) {
    throw error;
  }
}

mongoose.connection.on('connected', () => {
});

mongoose.connection.on('error', (err) => {
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
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