const DataLoader = require('dataloader');
const Message = require('../models/Message');

function createMessageLoader() {
  return new DataLoader(async (messageIds) => {
    const messages = await Message.find({
      _id: { $in: messageIds }
    }).lean();

    const messageMap = new Map();
    messages.forEach(msg => {
      messageMap.set(msg._id.toString(), msg);
    });

    return messageIds.map(id => messageMap.get(id.toString()) || null);
  });
}

module.exports = { createMessageLoader };