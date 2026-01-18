// // db/connection.js
// const mysql = require('mysql2/promise');
// require('dotenv').config();

// const pool = mysql.createPool({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME,
//     waitForConnections: true,
//     connectionLimit: 10
// });

// pool.getConnection()
//     .then(conn => {
//         console.log('✅ Database connected successfully');
//         conn.release();
//     })
//     .catch(err => {
//         console.error('Database connection failed:', err.message);
//         console.error(err); // full error object for debugging
//     });



// module.exports = pool;
