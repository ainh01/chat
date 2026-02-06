const mongoose = require('mongoose');

const lastMessageSchema = new mongoose.Schema({
  sender_id: {
    type: String,
    required: true,
    ref: 'User'
  },
  text: {
    type: String,
    required: true,
    maxlength: 100,
    trim: true
  },
  time_sent: {
    type: Date,
    required: true,
    default: Date.now
  }
}, { _id: false });

const conversationSchema = new mongoose.Schema({
  participant_ids: {
    type: [String],
    required: true,
    validate: {
      validator: function (arr) {
        if (arr.length !== 2) return false;
        if (arr[0] === arr[1]) return false;
        if (arr[0] > arr[1]) return false;
        return true;
      },
      message: 'participant_ids must contain exactly 2 unique sorted user IDs'
    },
    index: true
  },

  last_message: {
    type: lastMessageSchema,
    default: null
  },

  read_status: {
    type: Map,
    of: Date,
    default: () => new Map()
  },

  created_at: {
    type: Date,
    default: Date.now,
    immutable: true
  },

  is_blocked: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: false,
  collection: 'conversations'
});

conversationSchema.pre('save', function (next) {
  if (this.isModified('participant_ids')) {
    this.participant_ids.sort();
  }
});

conversationSchema.statics.findByParticipants = async function (userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return this.findOne({ participant_ids: sortedIds });
};

conversationSchema.methods.getOtherParticipant = function (currentUserId) {
  return this.participant_ids.find(id => id !== currentUserId);
};

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = Conversation;  