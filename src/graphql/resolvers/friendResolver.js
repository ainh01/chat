const { GraphQLError } = require('graphql');
const { requireAuth } = require('../../middleware/auth');
const { findUserById } = require('../../models/UserCore');
const FriendRequest = require('../../models/FriendRequest');
const FriendCore = require('../../models/FriendCore');

const resolvers = {
    Query: {
        myFriends: async (parent, args, context) => {
            const user = requireAuth(context);

            try {
                const friendsData = await FriendCore.getFriends(user.id);

                const friends = await Promise.all(
                    friendsData.map(async (friendData) => {
                        const friendUser = await findUserById(friendData.friend_id);
                        return {
                            friendId: friendData.friend_id,
                            friend: friendUser,
                            createdAt: friendData.created_at.toISOString()
                        };
                    })
                );

                return { friends };
            } catch (error) {
                throw new GraphQLError('Failed to fetch friends', {
                    extensions: { code: 'INTERNAL_SERVER_ERROR' }
                });
            }
        },

        userFriends: async (parent, { userId }, context) => {
            try {
                const targetUser = await findUserById(userId);
                if (!targetUser) {
                    throw new GraphQLError('User not found', {
                        extensions: { code: 'NOT_FOUND' }
                    });
                }

                const friendsData = await FriendCore.getFriends(userId);

                const friends = await Promise.all(
                    friendsData.map(async (friendData) => {
                        const friendUser = await findUserById(friendData.friend_id);
                        return {
                            friendId: friendData.friend_id,
                            friend: friendUser,
                            createdAt: friendData.created_at.toISOString()
                        };
                    })
                );

                return { friends };
            } catch (error) {
                if (error instanceof GraphQLError) throw error;
                throw new GraphQLError('Failed to fetch user friends', {
                    extensions: { code: 'INTERNAL_SERVER_ERROR' }
                });
            }
        },

        checkFriendship: async (parent, { userId1, userId2 }, context) => {
            try {
                const user1 = await findUserById(userId1);
                const user2 = await findUserById(userId2);

                if (!user1 || !user2) {
                    return {
                        areFriends: false,
                        userId1,
                        userId2
                    };
                }

                const areFriends = await FriendCore.areFriends(userId1, userId2);

                return {
                    areFriends,
                    userId1,
                    userId2
                };
            } catch (error) {
                return {
                    areFriends: false,
                    userId1,
                    userId2
                };
            }
        },

        myFriendRequests: async (parent, args, context) => {
            const user = requireAuth(context);

            try {
                const sentRequests = await FriendRequest.getSentRequests(user.id);
                const receivedRequests = await FriendRequest.getReceivedRequests(user.id);

                const sent = await Promise.all(
                    sentRequests.map(async (req) => {
                        const toUser = await findUserById(req.to_user_id);
                        const fromUser = await findUserById(req.from_user_id);
                        return {
                            id: req._id.toString(),
                            fromUserId: req.from_user_id,
                            toUserId: req.to_user_id,
                            fromUser,
                            toUser,
                            createdAt: req.created_at.toISOString()
                        };
                    })
                );

                const received = await Promise.all(
                    receivedRequests.map(async (req) => {
                        const toUser = await findUserById(req.to_user_id);
                        const fromUser = await findUserById(req.from_user_id);
                        return {
                            id: req._id.toString(),
                            fromUserId: req.from_user_id,
                            toUserId: req.to_user_id,
                            fromUser,
                            toUser,
                            createdAt: req.created_at.toISOString()
                        };
                    })
                );

                return { sent, received };
            } catch (error) {
                throw new GraphQLError('Failed to fetch friend requests', {
                    extensions: { code: 'INTERNAL_SERVER_ERROR' }
                });
            }
        }
    },

    Mutation: {
        sendFriendRequest: async (parent, { toUserId }, context) => {
            const user = requireAuth(context);

            try {
                if (user.id === toUserId) {
                    return {
                        success: false,
                        message: 'Cannot send friend request to yourself',
                        request: null
                    };
                }

                const targetUser = await findUserById(toUserId);
                if (!targetUser) {
                    return {
                        success: false,
                        message: 'Target user not found',
                        request: null
                    };
                }

                const alreadyFriends = await FriendCore.areFriends(user.id, toUserId);
                if (alreadyFriends) {
                    return {
                        success: false,
                        message: 'You are already friends with this user',
                        request: null
                    };
                }

                const existingRequests = await FriendRequest.findByUsers(user.id, toUserId);
                if (existingRequests.length > 0) {
                    return {
                        success: false,
                        message: 'Friend request already exists',
                        request: null
                    };
                }

                const request = await FriendRequest.createRequest(user.id, toUserId);

                const fromUser = await findUserById(request.from_user_id);
                const toUser = await findUserById(request.to_user_id);

                return {
                    success: true,
                    message: 'Friend request sent successfully',
                    request: {
                        id: request._id.toString(),
                        fromUserId: request.from_user_id,
                        toUserId: request.to_user_id,
                        fromUser,
                        toUser,
                        createdAt: request.created_at.toISOString()
                    }
                };
            } catch (error) {
                return {
                    success: false,
                    message: error.message || 'Failed to send friend request',
                    request: null
                };
            }
        },

        acceptFriendRequest: async (parent, { requestId }, context) => {
            const user = requireAuth(context);

            try {
                const request = await FriendRequest.findRequestById(requestId);
                if (!request) {
                    return {
                        success: false,
                        message: 'Friend request not found'
                    };
                }

                if (request.to_user_id !== user.id) {
                    return {
                        success: false,
                        message: 'You can only accept requests sent to you'
                    };
                }

                await request.accept();

                return {
                    success: true,
                    message: 'Friend request accepted successfully'
                };
            } catch (error) {
                return {
                    success: false,
                    message: error.message || 'Failed to accept friend request'
                };
            }
        },

        refuseFriendRequest: async (parent, { requestId }, context) => {
            const user = requireAuth(context);

            try {
                const request = await FriendRequest.findRequestById(requestId);
                if (!request) {
                    return {
                        success: false,
                        message: 'Friend request not found'
                    };
                }

                if (request.to_user_id !== user.id) {
                    return {
                        success: false,
                        message: 'You can only refuse requests sent to you'
                    };
                }

                await FriendRequest.deleteRequest(requestId);

                return {
                    success: true,
                    message: 'Friend request refused successfully'
                };
            } catch (error) {
                return {
                    success: false,
                    message: error.message || 'Failed to refuse friend request'
                };
            }
        },

        removeFriend: async (parent, { friendId }, context) => {
            const user = requireAuth(context);

            try {
                if (user.id === friendId) {
                    return {
                        success: false,
                        message: 'Invalid friend ID'
                    };
                }

                const areFriends = await FriendCore.areFriends(user.id, friendId);
                if (!areFriends) {
                    return {
                        success: false,
                        message: 'You are not friends with this user'
                    };
                }

                const deleted = await FriendCore.deleteFriendship(user.id, friendId);
                if (!deleted) {
                    return {
                        success: false,
                        message: 'Failed to remove friend'
                    };
                }

                return {
                    success: true,
                    message: 'Friend removed successfully'
                };
            } catch (error) {
                return {
                    success: false,
                    message: error.message || 'Failed to remove friend'
                };
            }
        }
    }
};

module.exports = {
    resolvers
};