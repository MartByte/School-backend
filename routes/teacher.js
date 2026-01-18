const express = require('express');
const router = express.Router();
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const Teacher = require('../models/Teacher');

/**
 * GET: Fetch students' attendance for a class on a given date
 */
router.get('/student-attendance/:className/:date', async (req, res) => {
    const { className, date } = req.params;

    try {
        // 1. Get all students in that class
        const students = await Student.find({ class: className }).sort({ Fname: 1, Lname: 1 });

        // 2. Get attendance records for that specific date and class source
        const attendanceRecords = await Attendance.find({ 
            date: date, 
            source: 'class' 
        });

        // 3. Map students to their attendance status (Replacing the SQL LEFT JOIN)
        const rows = students.map(s => {
            const record = attendanceRecords.find(a => a.studentID === s.studentID);
            return {
                studentID: s.studentID,
                Fname: s.Fname,
                Mname: s.Mname,
                Lname: s.Lname,
                class: s.class,
                town: s.town,
                attendanceStatus: record ? record.status : null
            };
        });

        res.json(rows);
    } catch (err) {
        console.error('Error fetching student attendance:', err);
        res.status(500).json({ message: 'Failed to fetch student attendance' });
    }
});

/**
 * POST: Mark student attendance
 */
router.post('/student-attendance', async (req, res) => {
    const { studentID, teacherID, adminID, date, status, source } = req.body;
    const classVal = req.body.class;

    if (!studentID || !classVal || !date || !status || (!teacherID && !adminID)) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    try {
        const finalSource = source || 'class';

        // Mongoose "findOneAndUpdate" with "upsert: true" replaces "INSERT ... ON DUPLICATE KEY UPDATE"
        await Attendance.findOneAndUpdate(
            { studentID, date, source: finalSource },
            { 
                status, 
                teacherID: teacherID || null, 
                adminID: adminID || null, 
                class: classVal 
            },
            { upsert: true, new: true }
        );

        const io = req.app.get('io');
        if (io) io.emit('refresh_data', { type: 'attendance_update', studentID });

        res.json({ success: true, message: 'Attendance recorded successfully' });
    } catch (err) {
        console.error("Attendance POST Error:", err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

/**
 * GET: Distinct classes
 */
router.get('/classes', async (req, res) => {
    try {
        const classes = await Student.distinct('class', { class: { $ne: null, $ne: '' } });
        res.json(classes.sort());
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch classes' });
    }
});

/**
 * POST: Students by class and town
 */
router.post('/students/by-class-town', async (req, res) => {
    const { town, class: className } = req.body;
    try {
        const students = await Student.find({ town, class: className }).sort({ Lname: 1, Fname: 1 });
        req.app.get('io')?.emit('refresh_data', { message: 'New activity detected' });
        res.json(students);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch students' });
    }
});

/**
 * GET: Distinct towns
 */
router.get('/towns', async (req, res) => {
    try {
        const towns = await Student.distinct('town', { town: { $ne: null, $ne: '' } });
        res.json(towns.sort());
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch towns' });
    }
});

/**
 * GET: Teacher information
 */
router.get('/teacher/:id/info', async (req, res) => {
    try {
        const teacher = await Teacher.findOne({ teacherID: req.params.id, isDeleted: false });
        if (!teacher) return res.status(404).json({ message: 'Teacher not found' });
        res.json(teacher);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch teacher info' });
    }
});



/**
 * GET: Teacher class attendance records (History)
 * /api/teacher/:id/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get('/teacher/:id/attendance', async (req, res) => {
    const { id } = req.params;
    const { start, end } = req.query;

    try {
        // 1. Find teacher's assigned class
        const teacher = await Teacher.findOne({ teacherID: id });
        if (!teacher) return res.status(404).json({ message: 'Teacher not found' });
        
        const assignedClass = teacher.assignedClass;
        if (!assignedClass) return res.json([]);

        // 2. Build the query filter
        let query = { class: assignedClass };

        // Handle date range if provided
        if (start && end) {
            query.date = { $gte: start, $lte: end };
        }

        // 3. Fetch attendance and manually "Join" student names
        const attendanceRecords = await Attendance.find(query).sort({ date: -1 });
        
        // 4. Enrich records with student names
        const enrichedRecords = await Promise.all(attendanceRecords.map(async (record) => {
            const student = await Student.findOne({ studentID: record.studentID });
            return {
                date: record.date,
                studentID: record.studentID,
                status: record.status,
                fullName: student ? `${student.Fname} ${student.Mname || ''} ${student.Lname}` : 'Unknown Student',
                class: assignedClass,
                town: student ? student.town : ''
            };
        }));

        res.json(enrichedRecords);
    } catch (err) {
        console.error('Error fetching teacher attendance records:', err);
        res.status(500).json({ message: 'Failed to fetch attendance records' });
    }
});
module.exports = router;