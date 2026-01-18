const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
    adminID: {
        type: String,
        required: true,
        unique: true
    },
    Fname: {
        type: String,
        required: true,
        trim: true
    },
    Lname: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
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
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('Admin', AdminSchema);