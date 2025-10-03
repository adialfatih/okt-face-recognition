require('dotenv').config();
const mysql = require('mysql2/promise');


const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONN_LIMIT || 10),
    queueLimit: 0
});


async function q(sql, params) {
    const [rows] = await pool.query(sql, params);
    return rows;
}


module.exports = { pool, q };