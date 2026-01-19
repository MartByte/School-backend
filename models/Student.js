const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
    studentID: { type: Number, required: true, unique: true },
    fname: { type: String, required: true },
    mname: { type: String },
    lname: { type: String, required: true },
    class: { type: String, required: true },
    town: { type: String, required: true },
    guardianPhone: { type: String },
    profilePic: { type: String },
    
    // Financial fields (previously separate SQL tables)
    advanceBalance: { type: Number, default: 0 }, 
    isCredit: { type: Number, default: 0 },
    isExempted: { type: Number, default: 0 },
    
    isDeleted: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Student', StudentSchema, 'students');