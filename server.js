require('dotenv').config();
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

// Route imports
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const canteenRoutes = require('./routes/canteen');
const teacherRoutes = require('./routes/teacher');

const app = express();
const server = http.createServer(app); 

// 1. MongoDB Connection
const dbURI = process.env.MONGODB_URI; 
mongoose.connect(dbURI)
  .then(() => console.log("✅ Successfully connected to MongoDB Atlas"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// 2. Socket.io Setup
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Make 'io' available to all routes
app.set('io', io);

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// 3. Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Network Logging
app.use((req, res, next) => {
    console.log(`[NETWORK LOG] ${req.method} ${req.url}`);
    next();
});

// Serve profile pics
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/**
 * 4. ROUTES (Preserving your exact frontend paths)
 */
app.use('/api', authRoutes);      // Frontend calls /api/login, etc.
app.use('/admin', adminRoutes);   // Frontend calls /admin/dashboard/admin-summary, etc.
app.use('/canteen', canteenRoutes); // Frontend calls /canteen/credit/flag, etc.
app.use('/api', teacherRoutes);   // Frontend calls /api/student-attendance, etc.

// Catch-all 404
app.use((req, res) => {
    res.status(404).json({ message: 'Route not found' });
});

// 5. Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server with Socket.io running on port ${PORT}`);
});