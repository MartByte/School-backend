require('dotenv').config();
const express = require('express');
const http = require('http'); // 1. Import http
const { Server } = require('socket.io'); // 2. Import Socket.io
const cors = require('cors');
const path = require('path');


// Route imports
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const canteenRoutes = require('./routes/canteen');
const teacherRoutes = require('./routes/teacher');
const mongoose = require('mongoose');


const dbURI = process.env.MONGODB_URI; 

mongoose.connect(dbURI)
  .then(() => console.log("✅ Successfully connected to MongoDB Atlas (Paris)"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

const app = express();
const server = http.createServer(app); // 3. Create the HTTP server

// 4. Initialize Socket.io
const io = new Server(server, {
    cors: {
        origin: "*", // Allow mobile devices to connect
        methods: ["GET", "POST"]
    }
});

// 5. Make 'io' available to all routes via the 'req' object
app.set('io', io);

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// app.js - Add this right after app.use(express.json())
app.use((req, res, next) => {
    console.log(`[NETWORK LOG] ${req.method} ${req.url}`);
    next();
});

// Serve profile pics
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api', authRoutes);
app.use('/admin', adminRoutes);
app.use('/canteen', canteenRoutes);
app.use('/api', teacherRoutes);

// Catch-all 404
app.use((req, res) => {
    res.status(404).json({ message: 'Route not found' });
});

// 6. IMPORTANT: Start the 'server', not 'app'
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server with Socket.io running on port ${PORT}`);
});