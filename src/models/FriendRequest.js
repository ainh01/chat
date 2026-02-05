const mongoose = require('mongoose');

const friendRequestSchema = new mongoose.Schema({
    from_user_id: {
        type: String,
        required: true,
        index: true
    },
    to_user_id: {
        type: String,
        required: true,
        index: true
    },
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: false,
    collection: 'friend_requests'
});

friendRequestSchema.index(
    { from_user_id: 1, to_user_id: 1 },
    { unique: true, name: 'idx_from_to_unique' }
);

friendRequestSchema.index(
    { to_user_id: 1, created_at: -1 },
    { name: 'idx_to_user_time' }
);

friendRequestSchema.statics.createRequest = async function (fromUserId, toUserId) {
    try {
        const request = new this({
            from_user_id: fromUserId,
            to_user_id: toUserId
        });
        await request.save();
        return request;
    } catch (error) {
        if (error.code === 11000) {
            throw new Error('Friend request already exists');
        }
        throw error;
    }
};

friendRequestSchema.statics.findByUsers = async function (userId1, userId2) {
    const requests = await this.find({
        $or: [
            { from_user_id: userId1, to_user_id: userId2 },
            { from_user_id: userId2, to_user_id: userId1 }
        ]
    });
    return requests;
};

friendRequestSchema.statics.findRequestById = async function (requestId) {
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
        return null;
    }
    return await this.findById(requestId);
};

friendRequestSchema.statics.deleteRequest = async function (requestId) {
    const result = await this.deleteOne({ _id: requestId });
    return result.deletedCount > 0;
};

friendRequestSchema.statics.getSentRequests = async function (userId) {
    return await this.find({ from_user_id: userId }).sort({ created_at: -1 });
};

friendRequestSchema.statics.getReceivedRequests = async function (userId) {
    return await this.find({ to_user_id: userId }).sort({ created_at: -1 });
};

friendRequestSchema.methods.accept = async function () {
    const FriendCore = require('./FriendCore');

    try {
        await FriendCore.createFriendship(this.from_user_id, this.to_user_id);

        await this.deleteOne();

        return { success: true };
    } catch (error) {
        throw new Error(`Failed to create friendship: ${error.message}`);
    }
};

const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);

module.exports = FriendRequest;