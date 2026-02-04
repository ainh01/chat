const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query, sql } = require('../db/sql/db.js');

const SALT_ROUNDS = 12;

async function generateUserId() {
  const MIN_ID = 1000000000000000n;
  const MAX_ID = 9999999999999999n;
  const RANGE = MAX_ID - MIN_ID + 1n;

  let attempts = 0;
  const MAX_ATTEMPTS = 10;

  while (attempts < MAX_ATTEMPTS) {
    try {
      const randomBytes = crypto.randomBytes(6);
      const randomBigInt = BigInt('0x' + randomBytes.toString('hex'));

      const baseId = 1000000000000000n + (randomBigInt % 8999999999999999n);

      const result = await query(
        'SELECT id FROM users WHERE id = @userId',
        { userId: baseId.toString() }
      );

      if (result.recordset.length === 0) {
        return baseId.toString();
      }

      attempts++;

    } catch (error) {
      throw new Error('Failed to generate unique user ID');
    }
  }

  throw new Error('Unable to generate unique ID after maximum attempts');
}

async function createUser(username, password) {
  try {
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const sanitizedUsername = username.trim().toLowerCase();

    const userId = await generateUserId();

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await query(
      `INSERT INTO users (id, username, password_hash)  
       VALUES (@userId, @username, @passwordHash)`,
      {
        userId,
        username: sanitizedUsername,
        passwordHash
      }
    );

    return {
      id: userId,
      username: sanitizedUsername
    };

  } catch (error) {
    if (error.number === 2627) {
      throw new Error('Username already exists');
    }
    throw error;
  }
}

async function findUserByUsername(username) {
  const result = await query(
    'SELECT id, username, password_hash FROM users WHERE username = @username',
    { username: username.trim().toLowerCase() }
  );

  return result.recordset.length > 0 ? result.recordset[0] : null;
}

async function findUserById(userId) {
  const result = await query(
    'SELECT id, username FROM users WHERE id = @userId',
    { userId }
  );

  return result.recordset.length > 0 ? result.recordset[0] : null;
}

async function verifyPassword(plainPassword, storedHash) {
  return await bcrypt.compare(plainPassword, storedHash);
}

module.exports = {
  generateUserId,
  createUser,
  findUserByUsername,
  findUserById,
  verifyPassword
};