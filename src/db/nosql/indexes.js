const Conversation = require('../../models/Conversation')
const Message = require('../../models/Message');

async function safeCreateIndex(collection, keyPattern, options) {
  const indexName = options.name;

  try {
    await collection.createIndex(keyPattern, options);
    return { success: true, action: 'created' };
  } catch (error) {
    if (error.codeName === 'IndexOptionsConflict') {
      const indexes = await collection.indexes();
      const existingIndex = indexes.find(idx =>
        JSON.stringify(idx.key) === JSON.stringify(keyPattern)
      );

      if (existingIndex) {
        return { success: true, action: 'exists', existingName: existingIndex.name };
      }
    }

    throw error;
  }
}

async function createIndexes() {
  try {
    console.log('Creating MongoDB indexes...\n');

    console.log('Creating conversations.participant_ids index...');
    await safeCreateIndex(
      Conversation.collection,
      { participant_ids: 1 },
      {
        name: 'idx_participant_ids',
        unique: true,
        background: false
      }
    );
    console.log('conversations.participant_ids indexed\n');

    console.log('Creating messages.conversation_id + time_sent compound index...');
    await safeCreateIndex(
      Message.collection,
      { conversation_id: 1, time_sent: -1 },
      {
        name: 'idx_conversation_time',
        background: false
      }
    );
    console.log('messages.conversation_id + time_sent indexed');
    console.log('Optimizes: Pagination queries (fetchMessages)\n');

    console.log('Creating messages._id + sender_id compound index...');
    await safeCreateIndex(
      Message.collection,
      { _id: 1, sender_id: 1 },
      {
        name: 'idx_message_ownership',
        background: false
      }
    );
    console.log('messages._id + sender_id indexed');
    console.log('Optimizes: Edit/unsend authorization checks\n');

    console.log('All indexes created/verified successfully!\n');

    console.log('Index Statistics:');
    const convIndexes = await Conversation.collection.indexes();
    const msgIndexes = await Message.collection.indexes();

    console.log(`Conversations: ${convIndexes.length} indexes`);
    convIndexes.forEach(idx => {
      console.log(`- ${idx.name}: ${JSON.stringify(idx.key)}`);
    });

    console.log(`Messages: ${msgIndexes.length} indexes`);
    msgIndexes.forEach(idx => {
      console.log(`- ${idx.name}: ${JSON.stringify(idx.key)}`);
    });

  } catch (error) {
    console.error('Index creation failed:', error.message);
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
      console.error('Fatal error:', error);
      process.exit(1);
    }
  })();
}