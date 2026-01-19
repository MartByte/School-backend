const mongoose = require('mongoose');
const teacherSchema = new mongoose.Schema({
    fname: String, 
    mname: String, 
    lname: String,
    teacherId: Number, // Database has 'teacherId' with a lowercase 'd' and it is a Number
    phone: String,
    town: String, 
    assignedClass: String, 
    isCanteenCollector: Number, // In Atlas this is 1 or 0
    isDeleted: Number,          // In Atlas this is 0
    role: String,
    passwordHash: String,
    profilePic: String
});

teacherSchema.set('collection', 'teachers');

module.exports = mongoose.model('Teacher', teacherSchema);