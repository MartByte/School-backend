const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
    studentID: { type: String, required: true, unique: true },
    fname: { type: String, required: true },
    mname: { type: String },
    lname: { type: String, required: true },
    class: { type: String, required: true },
    town: { type: String, required: true },
    guardianPhone: { type: String },
    profilePic: { type: String },
    
    // Financial fields (previously separate SQL tables)
    advanceBalance: { type: Number, default: 0 }, 
    isCredit: { type: Boolean, default: false },
    isExempted: { type: Boolean, default: false },
    
    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Student', StudentSchema);