require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');

// 1. Setup MySQL Connection Pool
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'feessystemdb', // Matched your actual DB name
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const app = express();

// 2. MIDDLEWARE (The Golden Order)
app.use(cors()); // Allow mobile app to talk to server
app.use(express.json()); // Fixes the "undefined" error by parsing JSON
app.use(express.urlencoded({ extended: true }));

// Pass 'db' to your request object
app.use((req, res, next) => {
    req.db = db;
    next();
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use('/uploads', express.static('uploads'));
app.set('io', io);

// 3. ROUTES
app.use('/api', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/canteen', require('./routes/canteen'));
app.use('/api', require('./routes/teacher'));

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`? Server running on port ${PORT}`);
});