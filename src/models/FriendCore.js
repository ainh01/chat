const { query, sql } = require('../db/sql/db.js');

function orderUserIds(userId1, userId2) {
    const id1 = BigInt(userId1);
    const id2 = BigInt(userId2);

    if (id1 < id2) {
        return { smallerId: userId1, largerId: userId2 };
    } else {
        return { smallerId: userId2, largerId: userId1 };
    }
}

async function createFriendship(userId1, userId2) {
    try {
        if (userId1 === userId2) {
            throw new Error('Cannot create friendship with self');
        }

        const { smallerId, largerId } = orderUserIds(userId1, userId2);

        await query(
            `INSERT INTO friendships (user_id_1, user_id_2)  
             VALUES (@userId1, @userId2)`,
            {
                userId1: smallerId,
                userId2: largerId
            }
        );

        return true;
    } catch (error) {
        if (error.number === 2627) {
            throw new Error('Friendship already exists');
        }
        if (error.number === 547) {
            throw new Error('One or both users do not exist');
        }
        throw error;
    }
}

async function deleteFriendship(userId1, userId2) {
    try {
        if (userId1 === userId2) {
            return false;
        }

        const { smallerId, largerId } = orderUserIds(userId1, userId2);

        const result = await query(
            `DELETE FROM friendships   
             WHERE user_id_1 = @userId1 AND user_id_2 = @userId2`,
            {
                userId1: smallerId,
                userId2: largerId
            }
        );

        return result.rowsAffected[0] > 0;
    } catch (error) {
        throw new Error(`Failed to delete friendship: ${error.message}`);
    }
}

async function getFriends(userId) {
    try {
        const result = await query(
            `SELECT   
                CASE   
                    WHEN user_id_1 = @userId THEN user_id_2  
                    ELSE user_id_1  
                END AS friend_id,  
                created_at  
             FROM friendships  
             WHERE user_id_1 = @userId OR user_id_2 = @userId  
             ORDER BY created_at DESC`,
            { userId }
        );

        return result.recordset;
    } catch (error) {
        throw new Error(`Failed to get friends: ${error.message}`);
    }
}

async function areFriends(userId1, userId2) {
    try {
        if (userId1 === userId2) {
            return false;
        }

        const { smallerId, largerId } = orderUserIds(userId1, userId2);

        const result = await query(
            `SELECT 1 FROM friendships   
             WHERE user_id_1 = @userId1 AND user_id_2 = @userId2`,
            {
                userId1: smallerId,
                userId2: largerId
            }
        );

        return result.recordset.length > 0;
    } catch (error) {
        return false;
    }
}

async function getFriendship(userId1, userId2) {
    try {
        if (userId1 === userId2) {
            return null;
        }

        const { smallerId, largerId } = orderUserIds(userId1, userId2);

        const result = await query(
            `SELECT user_id_1, user_id_2, created_at   
             FROM friendships   
             WHERE user_id_1 = @userId1 AND user_id_2 = @userId2`,
            {
                userId1: smallerId,
                userId2: largerId
            }
        );

        return result.recordset.length > 0 ? result.recordset[0] : null;
    } catch (error) {
        return null;
    }
}

module.exports = {
    createFriendship,
    deleteFriendship,
    getFriends,
    areFriends,
    getFriendship,
    orderUserIds
};