const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
    // 1. Matches "adminId": 105890 in Atlas
    adminId: {
        type: Number, 
        required: true,
        unique: true
    },
    fname: {
        type: String,
        required: true,
        trim: true
    },
    lname: {
        type: String,
        required: true,
        trim: true
    },
    // 2. Note: Your Atlas JSON didn't show an email, 
    // but keeping it if you plan to add it later.
    email: {
        type: String,
        lowercase: true,
        trim: true
    },
    // 3. Matches "passwordHash" in Atlas
    passwordHash: {
        type: String,
        required: true
    },
    role: {
        type: String,
        default: 'admin'
    },
    phone: {
        type: String,
        trim: true
    },
    // 4. Matches "isDeleted": 0 in Atlas
    isDeleted: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

// 5. Force collection name to 'admins' (ensure this matches Atlas collection name)
module.exports = mongoose.model('Admin', AdminSchema, 'admins');