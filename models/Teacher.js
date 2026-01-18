const mongoose = require('mongoose');
const teacherSchema = new mongoose.Schema({
    Fname: String, Mname: String, Lname: String,
    teacherID: { type: String, unique: true },
    passwordHash: String, phone: String,
    town: String, assignedClass: String, isCanteenCollector: Boolean,
    profilePic: String
});
module.exports = mongoose.model('Teacher', teacherSchema);