const sql = require('mssql');
const dotenv = require('dotenv');

dotenv.config();

function parseConnectionString(connStr) {
  const parts = {};
  const pairs = connStr.split(';').filter(p => p.trim());

  pairs.forEach(pair => {
    const [key, value] = pair.split('=').map(s => s.trim());
    if (key && value) {
      parts[key.toLowerCase()] = value;
    }
  });

  return parts;
}

const connStringParts = parseConnectionString(process.env.SQL_DATABASE || '');

const config = {
  server: connStringParts['server'] || 'localhost',
  database: connStringParts['database'] || 'master',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 20,
    min: 5,
    idleTimeoutMillis: 30000
  }
};

let pool = null;

async function getPool() {
  if (!pool) {
    try {
      pool = await sql.connect(config);

      pool.on('error', err => {
        pool = null;
      });

    } catch (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }
  }
  return pool;
}

async function query(queryText, params = {}) {
  try {
    const currentPool = await getPool();
    const request = currentPool.request();

    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }

    const result = await request.query(queryText);
    return result;

  } catch (error) {
    throw error;
  }
}

async function transaction(callback) {
  const currentPool = await getPool();
  const txn = new sql.Transaction(currentPool);

  try {
    await txn.begin();
    const result = await callback(txn);
    await txn.commit();
    return result;
  } catch (error) {
    await txn.rollback();
    throw error;
  }
}

async function closePool() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

module.exports = {
  getPool,
  query,
  transaction,
  closePool,
  sql
};