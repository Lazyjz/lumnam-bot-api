
// // db.js
// const mysql = require('mysql2/promise');
// require('dotenv').config();

// // ✅ ใช้ createPool แทน createConnection เพื่อรองรับการเชื่อมต่อหลายครั้ง
// const db = mysql.createPool({
//   host: process.env.DB_HOST || 'localhost',
//   port: process.env.DB_PORT || 3306,
//   user: process.env.DB_USER || 'root',
//   password: process.env.DB_PASSWORD || '',
//   database: process.env.DB_NAME || 'lumnambot',
//   charset: process.env.DB_CHARSET || 'utf8mb4',
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
// });
// // ✅ ทดสอบการเชื่อมต่อ
// (async () => {
//   try {
//     const connection = await db.getConnection();
//     console.log('✅ Connected to MySQL database');
//     console.log('[DB] host', process.env.DB_HOST, 'db', process.env.DB_NAME);
//     connection.release();
//   } catch (err) {
//     console.error('❌ Database connection failed:', err.message);
//   }
// })();

// module.exports = db;


// db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lumnambot',
  charset: process.env.DB_CHARSET || 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // ⚠️ เพิ่มบรรทัดนี้: ช่วยแก้ปัญหาเวลาต่อ Database ข้าม Server แล้วเจอ error เรื่อง Handshake
  //ssl: { rejectUnauthorized: false } 
});

// ✅ ทดสอบการเชื่อมต่อ (Log จะไปขึ้นใน Render Dashboard)
(async () => {
  try {
    const connection = await db.getConnection();
    console.log('✅ Connected to MySQL database');
    console.log('[DB] host:', process.env.DB_HOST, '| db:', process.env.DB_NAME);
    connection.release();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
  }
})();

module.exports = db;








