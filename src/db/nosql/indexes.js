const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const FriendRequest = require('../../models/FriendRequest');

async function safeCreateIndex(collection, keyPattern, options) {
  const indexName = options.name;

  try {
    const indexes = await collection.indexes();
    const existingIndex = indexes.find(idx =>
      JSON.stringify(idx.key) === JSON.stringify(keyPattern)
    );

    if (existingIndex) {
      return { success: true, action: 'exists', existingName: existingIndex.name };
    }

    await collection.createIndex(keyPattern, options);
    return { success: true, action: 'created' };

  } catch (error) {
    if (error.codeName === 'IndexOptionsConflict') {
      return { success: true, action: 'exists_with_conflict' };
    }
    throw error;
  }
}

async function createIndexes() {
  try {

    await safeCreateIndex(
      Conversation.collection,
      { participant_ids: 1 },
      {
        name: 'idx_participant_ids',
        unique: true,
        background: false
      }
    );

    await safeCreateIndex(
      Message.collection,
      { conversation_id: 1, time_sent: -1 },
      {
        name: 'idx_conversation_time',
        background: false
      }
    );

    await safeCreateIndex(
      FriendRequest.collection,
      { from_user_id: 1, to_user_id: 1 },
      {
        name: 'idx_from_to_unique',
        unique: true,
        background: false
      }
    );

    await safeCreateIndex(
      FriendRequest.collection,
      { to_user_id: 1, created_at: -1 },
      {
        name: 'idx_to_user_time',
        background: false
      }
    );

    await safeCreateIndex(
      FriendRequest.collection,
      { from_user_id: 1 },
      {
        name: 'idx_from_user',
        background: false
      }
    );

    const convIndexes = await Conversation.collection.indexes();
    const msgIndexes = await Message.collection.indexes();
    const friendReqIndexes = await FriendRequest.collection.indexes();

  } catch (error) {
    throw error;
  }
}

module.exports = { createIndexes };

if (require.main === module) {
  const { connectMongoDB, closeMongoConnection } = require('./db');

  (async () => {
    try {
      await connectMongoDB();
      await createIndexes();
      await closeMongoConnection();
      process.exit(0);
    } catch (error) {
      process.exit(1);
    }
  })();
}