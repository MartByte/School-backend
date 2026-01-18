const mongoose = require('mongoose');
const attendanceSchema = new mongoose.Schema({
    studentID: String,
    date: String, // Keep as YYYY-MM-DD string to match your frontend
    status: String, // 'present' or 'absent'
    town: String,
    source: { type: String, default: 'canteen' }
});
module.exports = mongoose.model('Attendance', attendanceSchema);