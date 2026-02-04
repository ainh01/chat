const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    _id: {
        type: String,
        required: true
    },

    last_online: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: false,
    collection: 'users'
});

userSchema.statics.updateLastOnline = async function (userId) {
    const timestamp = new Date();
    await this.updateOne(
        { _id: userId },
        {
            $set: { last_online: timestamp },
            $setOnInsert: { _id: userId }
        },
        { upsert: true }
    );
    return timestamp;
};

userSchema.methods.isOnline = function () {
    const twoMinutesAgo = new Date(Date.now() - 120000);
    return this.last_online >= twoMinutesAgo;
};

const User = mongoose.model('User', userSchema);

module.exports = User;  