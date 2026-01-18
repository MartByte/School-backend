const express = require('express');
const router = express.Router();
const db = require("../db/connection"); // your MySQL connection

/**
 *  GET: Fetch students' attendance for a class on a given date
 */
router.get('/student-attendance/:className/:date', async (req, res) => {
    const { className, date } = req.params;

    try {
        // Get all students in that class and check if they have an attendance record for that date
        const [rows] = await db.query(`
            SELECT 
                s.studentID,
                s.Fname,
                s.Mname,
                s.Lname,
                s.class,
                s.town,
                a.status AS attendanceStatus
            FROM students s
            LEFT JOIN attendance a 
                ON s.studentID = a.studentID 
                AND a.date = ?
                AND a.source = 'class'
            WHERE s.class = ?
            ORDER BY s.Fname, s.Lname
        `, [date, className]);


        res.json(rows);
    } catch (err) {
        console.error('Error fetching student attendance:', err);
        res.status(500).json({ message: 'Failed to fetch student attendance' });
    }
});


/**
 * POST: Mark student attendance (for class attendance)
 */
router.post('/student-attendance', async (req, res) => {
    console.log("DEBUG: Received Body ->", req.body);

    const { studentID, teacherID, adminID, date, status, source } = req.body;
    const classVal = req.body.class;

    // PROFESSIONAL VALIDATION: 
    // We need studentID, class, date, and status.
    // BUT, we only need EITHER teacherID OR adminID.
    const missingFields = [];
    if (!studentID) missingFields.push("studentID");
    if (!classVal) missingFields.push("class");
    if (!date) missingFields.push("date");
    if (!status) missingFields.push("status");
    
    // Check if both are missing
    if (!teacherID && !adminID) {
        missingFields.push("Authorized User ID (Teacher or Admin)");
    }

    if (missingFields.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Missing fields: ${missingFields.join(', ')}`
        });
    }

    try {
        const finalSource = source || 'class';

        // We use COALESCE or simple logic to ensure we don't break the INT requirement
        // If teacherID is null, the DB will store NULL (if you modified the column to be nullable)
        await db.query(
            `INSERT INTO attendance (studentID, teacherID, adminID, class, date, status, source) 
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
                status = VALUES(status), 
                teacherID = VALUES(teacherID),
                adminID = VALUES(adminID),
                class = VALUES(class)`, 
            [
                studentID, 
                teacherID || null, // Professional: Use NULL if not provided
                adminID || null,   // Professional: Track the admin separately
                classVal, 
                date, 
                status, 
                finalSource
            ]
        );

        // Real-time update
        const io = req.app.get('io');
        if (io) io.emit('refresh_data', { type: 'attendance_update', studentID });

        res.json({ success: true, message: 'Attendance recorded successfully' });
    } catch (err) {
        console.error("SQL ERROR:", err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

/**
 *  GET: Distinct classes
 */
router.get('/classes', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT DISTINCT class FROM students WHERE class IS NOT NULL AND class != '' ORDER BY class`);
        res.json(rows.map(r => r.class));
    } catch (err) {
        console.error('Error fetching classes:', err);
        res.status(500).json({ message: 'Failed to fetch classes' });
    }
    
});

/**
 * 📌 POST: Students by class and town
 * body: { town, class }
 */
router.post('/students/by-class-town', async (req, res) => {
    const { town, class: className } = req.body;
    if (!town || !className) {
        return res.status(400).json({ message: 'Missing town or class' });
    }
    try {
        const [rows] = await db.query(
            `SELECT studentID, Fname, Mname, Lname, class, town
             FROM students
             WHERE town = ? AND class = ?
             ORDER BY Lname, Fname`,
            [town, className]
        );
        const io = req.app.get('io');
io.emit('refresh_data', { message: 'New activity detected' });
        res.json(rows);
    } catch (err) {
        console.error('Error fetching students by class and town:', err);
        res.status(500).json({ message: 'Failed to fetch students' });
    }
});

/**
 * 📌 GET: Distinct towns
 */
router.get('/towns', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT DISTINCT town FROM students WHERE town IS NOT NULL AND town != '' ORDER BY town`);
        res.json(rows.map(r => r.town));
    } catch (err) {
        console.error('Error fetching towns:', err);
        res.status(500).json({ message: 'Failed to fetch towns' });
    }
});

/**
 * 📌 GET: Teacher information
 * /api/teacher/:id/info
 */
router.get('/teacher/:id/info', async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT teacherID, Fname, Mname, Lname, phone, role, town, assignedClass, isCanteenCollector FROM teachers WHERE teacherID = ? AND isDeleted = 0',
            [id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Teacher not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching teacher info:', err);
        res.status(500).json({ message: 'Failed to fetch teacher info' });
    }
});

/**
 * 📌 GET: Teacher class attendance records
 * /api/teacher/:id/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get('/teacher/:id/attendance', async (req, res) => {
    const { id } = req.params;
    const { start, end } = req.query;
    try {
        // Find teacher assigned class
        const [trows] = await db.query('SELECT assignedClass FROM teachers WHERE teacherID = ?', [id]);
        if (trows.length === 0) return res.status(404).json({ message: 'Teacher not found' });
        const assignedClass = trows[0].assignedClass;
        if (!assignedClass) return res.json([]);

        let sql = `
            SELECT a.date, a.studentID, a.status,
                   CONCAT(s.Fname, ' ', COALESCE(s.Mname,''), ' ', s.Lname) AS fullName,
                   s.class, s.town
            FROM attendance a
            JOIN students s ON s.studentID = a.studentID
            WHERE s.class = ?`;
        const params = [assignedClass];
        if (start && end) {
            sql += ' AND a.date BETWEEN ? AND ?';
            params.push(start, end);
        }
        sql += ' ORDER BY a.date DESC, s.Lname, s.Fname';

        const [rows] = await db.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching teacher attendance records:', err);
        res.status(500).json({ message: 'Failed to fetch attendance records' });
    }
});


module.exports = router;