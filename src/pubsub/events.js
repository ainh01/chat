const { PubSub } = require('graphql-subscriptions');

const pubsub = new PubSub();

const MESSAGE_SENT = 'MESSAGE_SENT';

module.exports = {
  pubsub,
  MESSAGE_SENT
};