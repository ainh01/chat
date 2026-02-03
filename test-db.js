const db = require('./src/db/sql/db');

async function testConnection() {
  try {
    console.log('🧪 Testing database connection...\n');
    
    const result = await db.query('SELECT @@VERSION AS Version, DB_NAME() AS CurrentDB, SYSTEM_USER AS LoginUser');
    
    console.log('✅ CONNECTION SUCCESSFUL!\n');
    console.log('📊 SQL Server:', result.recordset[0].Version.split('\n')[0]);
    console.log('📊 Database:', result.recordset[0].CurrentDB);
    console.log('📊 Logged in as:', result.recordset[0].LoginUser);
    console.log('\n✅ Everything is working!');
    
    await db.closePool();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ CONNECTION FAILED!');
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testConnection();
