const { GraphQLError } = require('graphql');
const { requireAuth } = require('../../middleware/auth');
const { findUserById } = require('../../models/UserCore');
const FriendCore = require('../../models/FriendCore');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const { v4: uuidv4 } = require('uuid');
const { withFilter } = require('graphql-subscriptions');
const {
    pubsub,
    CALL_SIGNAL,
    INCOMING_CALL,
    CALL_STATE_CHANGED
} = require('../../pubsub/events');

const STUN_SERVERS = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
];

const CALL_TTL = 7200;

async function getCallFromRedis(redisClient, callId) {
    try {
        const callData = await redisClient.get(`call:${callId}`);
        if (callData) {
            const parsedData = JSON.parse(callData);
            if (parsedData.startTime) parsedData.startTime = new Date(parsedData.startTime);
            if (parsedData.answerTime) parsedData.answerTime = new Date(parsedData.answerTime);
            if (parsedData.endTime) parsedData.endTime = new Date(parsedData.endTime);
            return parsedData;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function saveCallToRedis(redisClient, callId, callData) {
    try {
        const serializableCallData = { ...callData };
        if (serializableCallData.startTime instanceof Date) {
            serializableCallData.startTime = serializableCallData.startTime.toISOString();
        }
        if (serializableCallData.answerTime instanceof Date) {
            serializableCallData.answerTime = serializableCallData.answerTime.toISOString();
        }
        if (serializableCallData.endTime instanceof Date) {
            serializableCallData.endTime = serializableCallData.endTime.toISOString();
        }

        await redisClient.setEx(
            `call:${callId}`,
            CALL_TTL,
            JSON.stringify(serializableCallData)
        );
        return true;
    } catch (error) {
        return false;
    }
}

async function deleteCallFromRedis(redisClient, callId) {
    try {
        await redisClient.del(`call:${callId}`);
        return true;
    } catch (error) {
        return false;
    }
}

function isCallParticipant(call, userId) {
    return call.participantIds.includes(userId);
}

async function saveCallHistory(callData, duration = null) {
    try {
        const [user1, user2] = callData.participantIds;

        const sortedIds = [user1, user2].sort();
        let conversation = await Conversation.findOne({
            participant_ids: sortedIds
        });

        if (!conversation) {
            conversation = new Conversation({
                participant_ids: sortedIds,
                last_message: null,
                read_status: new Map(),
                created_at: new Date(),
                is_blocked: false
            });
            await conversation.save();
        }

        const initiatorId = callData.participantIds[0];
        const recipientId = callData.participantIds[1];

        const timeSent = callData.startTime instanceof Date ? callData.startTime : new Date(callData.startTime);

        const callMessage = new Message({
            conversation_id: conversation._id,
            sender_id: initiatorId,
            recipient_id: recipientId,
            content: `${callData.type.toUpperCase()} call`,
            time_sent: timeSent,
            meta: {
                is_unsent: false,
                is_forwarded: false,
                reply_to: null,
                last_edit_at: null
            },
            reactions: [],
            call_metadata: {
                type: callData.type,
                duration: duration,
                status: callData.status === 'ended' ? 'completed' : callData.status,
                initiated_by: initiatorId
            }
        });

        await callMessage.save();

        await Conversation.updateOne(
            { _id: conversation._id },
            {
                $set: {
                    last_message: {
                        sender_id: initiatorId,
                        text: `${callData.type} call`,
                        time_sent: callMessage.time_sent
                    }
                }
            }
        );

        return callMessage;
    } catch (error) {
        throw new GraphQLError('Failed to save call history', {
            extensions: { code: 'INTERNAL_SERVER_ERROR' }
        });
    }
}

const resolvers = {
    Mutation: {
        async initiateCall(_, { recipientId, callType }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            if (!redisClient) {
                throw new GraphQLError('Service temporarily unavailable', {
                    extensions: { code: 'INTERNAL_SERVER_ERROR' }
                });
            }

            if (user.id === recipientId) {
                return {
                    success: false,
                    message: 'Cannot call yourself',
                    call: null,
                    stunServers: null
                };
            }

            const recipient = await findUserById(recipientId);
            if (!recipient) {
                return {
                    success: false,
                    message: 'Recipient not found',
                    call: null,
                    stunServers: null
                };
            }

            const areFriends = await FriendCore.areFriends(user.id, recipientId);
            if (!areFriends) {
                return {
                    success: false,
                    message: 'You can only call friends',
                    call: null,
                    stunServers: null
                };
            }

            const callId = uuidv4();
            const callData = {
                id: callId,
                participantIds: [user.id, recipientId],
                type: callType.toLowerCase(),
                status: 'initiating',
                startTime: new Date()
            };

            const saved = await saveCallToRedis(redisClient, callId, callData);
            if (!saved) {
                throw new GraphQLError('Failed to initiate call', {
                    extensions: { code: 'INTERNAL_SERVER_ERROR' }
                });
            }

            callData.status = 'ringing';
            await saveCallToRedis(redisClient, callId, callData);

            pubsub.publish(INCOMING_CALL, {
                incomingCall: {
                    call: callData,
                    caller: {
                        id: user.id,
                        username: user.username
                    }
                },
                recipientId
            });

            return {
                success: true,
                message: 'Call initiated successfully',
                call: callData,
                stunServers: {
                    urls: STUN_SERVERS
                }
            };
        },

        async answerCall(_, { callId }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                return {
                    success: false,
                    message: 'Call not found or expired',
                    call: null,
                    stunServers: null
                };
            }

            if (callData.participantIds[1] !== user.id) {
                return {
                    success: false,
                    message: 'Unauthorized to answer this call',
                    call: null,
                    stunServers: null
                };
            }

            if (callData.status !== 'ringing') {
                return {
                    success: false,
                    message: `Cannot answer call in ${callData.status} state`,
                    call: null,
                    stunServers: null
                };
            }

            callData.status = 'active';
            callData.answerTime = new Date();
            await saveCallToRedis(redisClient, callId, callData);

            pubsub.publish(CALL_STATE_CHANGED, {
                callStateChanged: {
                    callId,
                    status: 'active',
                    timestamp: new Date()
                },
                callId
            });

            return {
                success: true,
                message: 'Call answered',
                call: callData,
                stunServers: {
                    urls: STUN_SERVERS
                }
            };
        },

        async rejectCall(_, { callId }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                throw new GraphQLError('Call not found', {
                    extensions: { code: 'NOT_FOUND' }
                });
            }

            if (!isCallParticipant(callData, user.id)) {
                throw new GraphQLError('Unauthorized', {
                    extensions: { code: 'FORBIDDEN' }
                });
            }

            callData.status = 'rejected';
            callData.endTime = new Date();

            await saveCallHistory(callData, null);

            await deleteCallFromRedis(redisClient, callId);

            pubsub.publish(CALL_STATE_CHANGED, {
                callStateChanged: {
                    callId,
                    status: 'rejected',
                    timestamp: new Date()
                },
                callId
            });

            return true;
        },

        async endCall(_, { callId }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                throw new GraphQLError('Call not found', {
                    extensions: { code: 'NOT_FOUND' }
                });
            }

            if (!isCallParticipant(callData, user.id)) {
                throw new GraphQLError('Unauthorized', {
                    extensions: { code: 'FORBIDDEN' }
                });
            }

            const endTime = new Date();
            let duration = null;
            let finalStatus = 'ended';

            if (callData.status === 'active' && callData.answerTime instanceof Date) {
                duration = Math.floor((endTime.getTime() - callData.answerTime.getTime()) / 1000);
            } else if (callData.status === 'ringing') {
                finalStatus = 'missed';
            }

            callData.status = finalStatus;
            callData.endTime = endTime;

            await saveCallHistory(callData, duration);

            await deleteCallFromRedis(redisClient, callId);

            pubsub.publish(CALL_STATE_CHANGED, {
                callStateChanged: {
                    callId,
                    status: finalStatus,
                    timestamp: endTime
                },
                callId
            });

            return true;
        },

        async sendSDPOffer(_, { callId, sdp }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                throw new GraphQLError('Call not found', {
                    extensions: { code: 'NOT_FOUND' }
                });
            }

            if (!isCallParticipant(callData, user.id)) {
                throw new GraphQLError('Unauthorized', {
                    extensions: { code: 'FORBIDDEN' }
                });
            }

            pubsub.publish(CALL_SIGNAL, {
                callSignal: {
                    callId,
                    senderId: user.id,
                    type: 'offer',
                    payload: sdp
                },
                callId
            });

            return true;
        },

        async sendSDPAnswer(_, { callId, sdp }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                throw new GraphQLError('Call not found', {
                    extensions: { code: 'NOT_FOUND' }
                });
            }

            if (!isCallParticipant(callData, user.id)) {
                throw new GraphQLError('Unauthorized', {
                    extensions: { code: 'FORBIDDEN' }
                });
            }

            pubsub.publish(CALL_SIGNAL, {
                callSignal: {
                    callId,
                    senderId: user.id,
                    type: 'answer',
                    payload: sdp
                },
                callId
            });

            return true;
        },

        async sendICECandidate(_, { callId, candidate }, context) {
            const user = requireAuth(context);
            const { redisClient } = context;

            const callData = await getCallFromRedis(redisClient, callId);
            if (!callData) {
                throw new GraphQLError('Call not found', {
                    extensions: { code: 'NOT_FOUND' }
                });
            }

            if (!isCallParticipant(callData, user.id)) {
                throw new GraphQLError('Unauthorized', {
                    extensions: { code: 'FORBIDDEN' }
                });
            }

            pubsub.publish(CALL_SIGNAL, {
                callSignal: {
                    callId,
                    senderId: user.id,
                    type: 'ice-candidate',
                    payload: candidate
                },
                callId
            });

            return true;
        }
    },

    Subscription: {
        incomingCall: {
            subscribe: withFilter(
                () => pubsub.asyncIterator([INCOMING_CALL]),
                (payload, variables, context) => {
                    if (!context.user) return false;
                    return payload.recipientId === context.user.id;
                }
            ),
            resolve(payload) {
                if (payload.incomingCall.call.startTime && typeof payload.incomingCall.call.startTime === 'string') {
                    payload.incomingCall.call.startTime = new Date(payload.incomingCall.call.startTime);
                }
                return payload.incomingCall;
            }
        },

        callSignal: {
            subscribe: withFilter(
                () => pubsub.asyncIterator([CALL_SIGNAL]),
                async (payload, variables, context) => {
                    if (!context.user) return false;
                    if (payload.callId !== variables.callId) return false;

                    const callData = await getCallFromRedis(context.redisClient, variables.callId);
                    if (!callData) return false;

                    return payload.callSignal.senderId !== context.user.id && isCallParticipant(callData, context.user.id);
                }
            ),
            resolve(payload) {
                return payload.callSignal;
            }
        },

        callStateChanged: {
            subscribe: withFilter(
                () => pubsub.asyncIterator([CALL_STATE_CHANGED]),
                async (payload, variables, context) => {
                    if (!context.user) return false;
                    if (payload.callId !== variables.callId) return false;

                    const callData = await getCallFromRedis(context.redisClient, variables.callId);
                    if (!callData) return false;

                    return isCallParticipant(callData, context.user.id);
                }
            ),
            resolve(payload) {
                if (payload.callStateChanged.timestamp && typeof payload.callStateChanged.timestamp === 'string') {
                    payload.callStateChanged.timestamp = new Date(payload.callStateChanged.timestamp);
                }
                return payload.callStateChanged;
            }
        }
    }
};

module.exports = { resolvers };