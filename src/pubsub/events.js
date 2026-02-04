const { PubSub } = require('graphql-subscriptions');

const pubsub = new PubSub();

const MESSAGE_SENT = 'MESSAGE_SENT';

const READ_STATUS_CHANGED = 'READ_STATUS_CHANGED';
const USER_STATUS_CHANGED = 'USER_STATUS_CHANGED';
const TYPING = 'TYPING';

module.exports = {
  pubsub,
  MESSAGE_SENT,
  READ_STATUS_CHANGED,
  USER_STATUS_CHANGED,
  TYPING
};