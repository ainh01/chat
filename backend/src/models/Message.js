const mongoose = require('mongoose');

const messageMetaSchema = new mongoose.Schema({
  is_unsent: {
    type: Boolean,
    default: false
  },
  is_forwarded: {
    type: Boolean,
    default: false
  },
  reply_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null
  },
  last_edit_at: {
    type: Date,
    default: null
  }
}, { _id: false });

const reactionSchema = new mongoose.Schema({
  user_id: {
    type: String,
    required: true
  },
  type: {
    type: Number,
    required: true,
    min: 1,
    max: 6,
    validate: {
      validator: Number.isInteger,
      message: 'Reaction type must be integer between 1-6'
    }
  }
}, { _id: false });

const callMetadataSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['voice', 'video', 'screen'],
    required: true
  },
  duration: {
    type: Number,
    default: null,
    min: 0
  },
  status: {
    type: String,
    enum: ['completed', 'missed', 'rejected'],
    required: true
  },
  initiated_by: {
    type: String,
    required: true,
    ref: 'User'
  }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  conversation_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true
  },

  sender_id: {
    type: String,
    required: true,
    ref: 'User'
  },

  recipient_id: {
    type: String,
    required: true,
    ref: 'User'
  },

  content: {
    type: String,
    required: true,
    maxlength: 5000,
    trim: true,
    validate: {
      validator: function (v) {
        return this.meta?.is_unsent || v.length > 0;
      },
      message: 'Message content cannot be empty'
    }
  },

  time_sent: {
    type: Date,
    default: Date.now,
    required: true,
    immutable: true,
    index: true
  },

  meta: {
    type: messageMetaSchema,
    default: () => ({})
  },

  reactions: {
    type: [reactionSchema],
    default: []
  },

  call_metadata: {
    type: callMetadataSchema,
    default: null
  }
}, {
  timestamps: false,
  collection: 'messages'
});

messageSchema.index({ conversation_id: 1, time_sent: -1 });
messageSchema.index({ _id: 1, sender_id: 1 });

messageSchema.virtual('isVisible').get(function () {
  return !this.meta.is_unsent;
});

messageSchema.methods.getDisplayContent = function () {
  if (this.meta.is_unsent) {
    return null;
  }
  return this.content;
};

messageSchema.statics.fetchPaginated = async function (conversationId, cursorDate = new Date(), limit = 20) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  return this.find({
    conversation_id: conversationId,
    time_sent: { $lt: cursorDate }
  })
    .sort({ time_sent: -1 })
    .limit(safeLimit + 1);
};

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;