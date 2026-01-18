const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const multer = require('multer');
const path = require('path');
const isValidPhone = require('../utils/validatePhone');

/**
 * CONFIGURATION & HELPERS
 */
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, `teacher_${Date.now()}${path.extname(file.originalname)}`);
    },
});
const upload = multer({ storage });

const normalizeProfilePic = (pic) => {
    if (!pic) return null;
    return pic.includes('/') ? pic.split('/').pop() : pic.replace('uploads/', '');
};

// ==========================================
// 1. STUDENT MANAGEMENT
// ==========================================

// GET students by class (Read-only: No Socket Emit)
router.get('/by-class/:className', async (req, res) => {
    const { className } = req.params;
    const today = new Date().toLocaleDateString('en-CA');
    try {
        const [rows] = await db.query(
            `SELECT 
                s.studentID, 
                CONCAT(s.Fname, ' ', s.Lname) AS fullName, 
                s.town, 
                s.class,
                (SELECT status FROM attendance 
                 WHERE studentID = s.studentID AND date = ? AND source = 'class' LIMIT 1) AS attendanceStatus,
                (SELECT CASE WHEN amount > 0 THEN 'Paid' ELSE 'Unpaid' END 
                 FROM canteen_fees 
                 WHERE studentID = s.studentID AND date = ? LIMIT 1) AS paymentStatus
             FROM students s
             WHERE s.class = ? AND s.isDeleted = 0
             ORDER BY s.Lname ASC`,
            [today, today, className]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// ADD Student (Write-only: Sockets used to notify Admin)
router.post('/students/add', upload.single('profilePic'), async (req, res) => {
    const { Fname, Mname, Lname, class: className, town, guardianPhone } = req.body;
    
    // 1. Validate Phone
    const validatedPhone = isValidPhone(guardianPhone);
    if (!validatedPhone) {
        return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // 2. Generate Custom ID (e.g., STD-2026-0001)
        await conn.query("CALL generate_custom_id('student', @newID)");
        const [[{ '@newID': studentID }]] = await conn.query("SELECT @newID");

        if (!studentID) throw new Error("ID Generation Failed");

        // 3. Insert Student Data
        const sql = `
            INSERT INTO students (
                studentID, Fname, Mname, Lname, class, town, guardianPhone, profilePic
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const params = [
            studentID, 
            Fname.trim(), 
            Mname ? Mname.trim() : null, 
            Lname.trim(), 
            className, 
            town, 
            validatedPhone,
            req.file ? req.file.filename : null
        ];

        await conn.query(sql, params);
        await conn.commit();

        // 4. Socket.io Real-time Notification
        const io = req.app.get('io');
        if (io) {
            io.emit('refresh_data', { 
                type: 'attendance_update', 
                message: `New student ${Fname} added` 
            });
        }

        res.status(201).json({ success: true, studentID });

    } catch (err) {
        await conn.rollback();
        console.error("Add Student Error:", err);
        res.status(500).json({ success: false, message: 'Failed to add student to database' });
    } finally {
        conn.release();
    }
});

router.get('/by-town/:townName', async (req, res) => {
    const { townName } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT 
                studentID, 
                CONCAT(Fname, ' ', Lname) AS fullName, 
                town, 
                class 
             FROM students 
             WHERE town = ? AND isDeleted = 0
             ORDER BY Lname ASC`,
            [townName]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching students by town:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/students/all', async (req, res) => {
    try {
        const [students] = await db.query('SELECT * FROM students ORDER BY Lname ASC');
        res.json(students);
    } catch (err) {
        res.status(500).json({ message: 'Internal server error' });
    }
});


router.put('/students/edit/:studentID', async (req, res) => {
    const { studentID } = req.params;
    const { Fname, Mname, Lname, className, town } = req.body;
    try {
        await db.query(
            `UPDATE students SET Fname=?, Mname=?, Lname=?, class=?, town=? WHERE studentID=?`,
            [Fname, Mname, Lname, className, town, studentID]
        );
//         const io = req.app.get('io');
// io.emit('refresh_data', { message: 'New activity detected' });
        res.json({ message: 'Student updated' });
    } catch (err) { res.status(500).json({ message: 'Update failed' }); }
});


// ==========================================
// 2. TEACHER MANAGEMENT
// ==========================================

router.get('/all/teachers', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT teacherID, CONCAT(Fname, ' ', Lname) AS fullName, email, phone, assignedClass, profilePic, town,
                (SELECT status FROM attendance WHERE teacherID = teachers.teacherID AND date = CURDATE() LIMIT 1) as attendanceStatus
             FROM teachers WHERE isDeleted = 0 ORDER BY Lname ASC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch teachers' });
    }
});

router.post('/add-teacher', upload.single('profilePic'), async (req, res) => {
    const { 
        Fname, Mname, Lname, phone, role, 
        town, assignedClass, isCanteenCollector 
    } = req.body;

    // 1. Validate Phone
    const formattedPhone = isValidPhone(phone);
    if (!formattedPhone) {
        return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    // 2. Database Connection Logic
    const connection = await db.getConnection(); 
    try {
        await connection.beginTransaction();

        // 3. Generate Custom ID using your Procedure
        await connection.query(`CALL generate_custom_id('teacher', @newID)`);
        const [[{ '@newID': teacherID }]] = await connection.query("SELECT @newID");

        if (!teacherID) throw new Error("Failed to generate Teacher ID");

        // 4. Data Normalization
        // FormData sends "0"/"1" as strings. Convert to Integer for MySQL BIT or TINYINT
        const collectorValue = parseInt(isCanteenCollector) === 1 ? 1 : 0;
        
        const sql = `
            INSERT INTO teachers (
                teacherID, Fname, Mname, Lname, phone, 
                role, town, assignedClass, isCanteenCollector, profilePic
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const params = [
            teacherID,
            Fname.trim(),
            Mname ? Mname.trim() : null,
            Lname.trim(),
            formattedPhone,
            role || 'teacher',
            town ? town.trim() : null,
            assignedClass ? assignedClass.trim() : null,
            collectorValue,
            req.file ? req.file.filename : null // Save the filename from Multer
        ];

        await connection.query(sql, params);
        await connection.commit();

        res.status(200).json({ 
            success: true, 
            message: 'Teacher added successfully', 
            teacherID 
        });

    } catch (err) {
        await connection.rollback();
        console.error("Add Teacher Error:", err);
        res.status(500).json({ success: false, message: 'Database insertion failed' });
    } finally {
        connection.release();
    }
});

router.get('/teachers/attendance', async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
        const [rows] = await db.query(`
            SELECT 
                t.teacherID, 
                t.Fname, 
                t.Lname, 
                t.profilePic, 
                a.status -- This will be NULL if you haven't marked it
            FROM teachers t
            LEFT JOIN teacher_attendance a ON t.teacherID = a.teacherID AND a.date = ?
            WHERE t.isDeleted = 0 
            ORDER BY t.Lname`, 
        [date]);

        res.json(rows.map(t => ({ 
            ...t, 
            status: t.status || null, // Explicitly send null if not in table
            profilePic: normalizeProfilePic(t.profilePic) 
        })));
    } catch (err) { 
        console.error(err);
        res.status(500).json({ message: 'Fetch failed' }); 
    }
});

router.post('/teachers/attendance', async (req, res) => {
    const { attendanceList, date } = req.body;

    if (!attendanceList || !Array.isArray(attendanceList)) {
        return res.status(400).json({ success: false, message: 'Invalid data format' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Loop through the list and update/insert each record
        for (const record of attendanceList) {
            await connection.query(`
                INSERT INTO teacher_attendance (teacherID, date, status, markedBy)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    status = VALUES(status),
                    markedBy = VALUES(markedBy)
            `, [record.teacherID, date, record.status, record.markedBy]);
        }

        await connection.commit();
        res.json({ success: true, message: 'Attendance saved successfully' });
    } catch (err) {
        await connection.rollback();
        console.error("Teacher Attendance Save Error:", err);
        res.status(500).json({ success: false, message: 'Database error' });
    } finally {
        connection.release();
    }
});

// ==========================================
// 3. THE ADMIN DASHBOARD (CENTRAL HUB)
// ==========================================

router.post('/dashboard/admin-summary', async (req, res) => {
    try {
        // Using YYYY-MM-DD format to match database DATE columns
        const today = new Date().toLocaleDateString('en-CA'); 
        
        // Parallel queries for high performance
        const [ 
            [s],        // Total Students
            [t],        // Total Teachers
            [rev],      // Total Revenue (Daily + Topups)
            [classAtt], // Total Present in Class
            [feesData], // Breakdown of payment types
            [gap]       // The Audit Gap (In Class but NOT in Canteen Fees)
        ] = await Promise.all([
            // 1. Total active students
            db.query("SELECT COUNT(*) as count FROM students WHERE isDeleted = 0"),

            // 2. Total active teachers
            db.query("SELECT COUNT(*) as count FROM teachers WHERE isDeleted = 0"),

            // 3. Total Cash Revenue collected today
            db.query(`SELECT SUM(amount) as total FROM canteen_fees 
                      WHERE DATE(date) = ? AND paymentType IN ('daily', 'advance_topup')`, [today]),

            // 4. Students marked present in class
            db.query(`SELECT COUNT(DISTINCT studentID) as count FROM attendance 
                      WHERE DATE(date) = ? AND source = 'class' AND status = 'present'`, [today]),

            // 5. Canteen Statistics (How many ate per category)
            db.query(`SELECT 
                        COUNT(DISTINCT CASE WHEN paymentType = 'daily' THEN studentID END) as dailyEaten,
                        COUNT(DISTINCT CASE WHEN paymentType = 'advance' THEN studentID END) as advEaten,
                        COUNT(DISTINCT CASE WHEN paymentType = 'credit' THEN studentID END) as creditEaten,
                        COUNT(DISTINCT studentID) as totalEaten
                      FROM canteen_fees WHERE DATE(date) = ? AND paymentType != 'advance_topup'`, [today]),

            // 6. THE AUDIT GAP: Present in class but NO record in canteen_fees
            db.query(`SELECT COUNT(DISTINCT a.studentID) as count 
                      FROM attendance a 
                      WHERE DATE(a.date) = ? 
                      AND a.source = 'class' 
                      AND a.status = 'present' 
                      AND NOT EXISTS (
                          SELECT 1 FROM canteen_fees c 
                          WHERE c.studentID = a.studentID 
                          AND DATE(c.date) = ? 
                          AND c.paymentType != 'advance_topup'
                      )`, [today, today])
        ]);

        // Calculate Totals safely
        const totalPaidCount = (feesData[0].dailyEaten || 0) + 
                             (feesData[0].advEaten || 0) + 
                             (feesData[0].creditEaten || 0);

        res.json({
            totalStudents: s[0].count,
            totalTeachers: t[0].count,
            totalCollected: rev[0].total || 0,
            canteenPresent: feesData[0].totalEaten || 0, // Now matches your report exactly
            classPresent: classAtt[0].count,
            dailyCount: feesData[0].dailyEaten,
            advanceCount: feesData[0].advEaten,
            debitCount: feesData[0].creditEaten,
            missedCanteen: gap[0].count // Students who are in class but haven't paid/eaten
        });

    } catch (err) { 
        console.error("Dashboard Summary Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});


router.get('/global-stats', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const [stats] = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM students) as totalStudents,
                (SELECT COUNT(DISTINCT studentID) FROM attendance WHERE date = ? AND status = 'present') as presentToday,
                (SELECT SUM(amount) FROM canteen_fees WHERE date = ?) as revenue
            `, [today, today]);

        res.json({ success: true, data: stats[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});


router.get('/attendance-summary', async (req, res) => {
    const { date } = req.query;
    try {
        const [rows] = await db.query(`
            SELECT 
                s.class,
                COUNT(DISTINCT s.studentID) as total_students,
                COUNT(DISTINCT a.studentID) as marked_count,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_count
            FROM students s
            LEFT JOIN attendance a ON s.studentID = a.studentID AND a.date = ?
            GROUP BY s.class
            ORDER BY s.class ASC
        `, [date]);
        const io = req.app.get('io');
io.emit('refresh_data', { message: 'New activity detected' });


        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Database error" });
    }
});

router.get('/reports/audit-gap-details', async (req, res) => {
    // Standardize date to YYYY-MM-DD
    const today = new Date().toLocaleDateString('en-CA'); 

    try {
        const [students] = await db.query(`
            SELECT 
                s.studentID, 
                -- Concatenate names, handling NULL Middle Names gracefully
                TRIM(CONCAT(s.Fname, ' ', IFNULL(s.Mname, ''), ' ', s.Lname)) AS name,
                s.class, 
                s.town
            FROM attendance a
            JOIN students s ON a.studentID = s.studentID
            WHERE DATE(a.date) = ? 
              AND a.source = 'class' 
              AND a.status = 'present'
              AND NOT EXISTS (
                  SELECT 1 FROM canteen_fees c 
                  WHERE c.studentID = a.studentID 
                    AND DATE(c.date) = ?
              )
            ORDER BY s.class ASC, s.Fname ASC`, [today, today]);
            
        res.json({ success: true, data: students });
    } catch (err) {
        console.error("Audit Gap API Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/reports/balances', async (req, res) => {
    try {
        const query = `
            SELECT 
                s.studentID, 
                CONCAT(s.Fname, ' ', IFNULL(s.Mname, ''), ' ', s.Lname) AS name, 
                s.class, 
                s.town, 
                CAST(IFNULL(b.balance, 0) AS DECIMAL(10,2)) AS balance,
                IFNULL(cf.active, 0) as is_credit
            FROM students s
            -- LEFT JOIN to check balances and credit status
            LEFT JOIN canteen_balances b ON s.studentID = b.studentID
            LEFT JOIN canteen_credit_flags cf ON s.studentID = cf.studentID
            -- FILTER: Only show if they have a non-zero balance OR are a Credit student
            WHERE IFNULL(b.balance, 0) != 0 OR IFNULL(cf.active, 0) = 1
            ORDER BY b.balance ASC;
        `;

        const [rows] = await db.query(query);
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error("Report Error:", err.message);
        res.status(500).json({ success: false, message: "Database error" });
    }
});


// ==========================================
// 4. REPORTS & DOWNLOADS
// ==========================================

// --- 1. DAILY CANTEEN REPORT ---
router.get('/reports/canteen/daily', async (req, res) => {
    let { date, town } = req.query;
    if (!date) date = new Date().toISOString().split('T')[0];
    else if (date.includes('T')) date = date.split('T')[0];

    try {
        let sql = `
            SELECT 
                s.studentID, 
                CONCAT(s.Fname, ' ', s.Lname) as name, 
                MAX(s.class) as class,
                MAX(s.town) as town,
                MAX(CASE WHEN a.source = 'class' AND a.status = 'present' THEN 1 ELSE 0 END) as inClass,
                MAX(CASE WHEN a.source = 'canteen' AND a.status = 'present' THEN 1 ELSE 0 END) as inCanteen,
                
                -- Physical Cash
                (SELECT IFNULL(SUM(amount), 0) FROM canteen_fees 
                 WHERE studentID = s.studentID AND DATE(date) = DATE(?) 
                 AND paymentType IN ('daily', 'advance_topup')) as cashReceived,

                -- Debt Incurred
                (SELECT IFNULL(SUM(amount), 0) FROM canteen_fees 
                 WHERE studentID = s.studentID AND DATE(date) = DATE(?) 
                 AND paymentType = 'credit') as creditIncurred,

                -- Pre-paid Used
                (SELECT IFNULL(SUM(amount), 0) FROM canteen_fees 
                 WHERE studentID = s.studentID AND DATE(date) = DATE(?) 
                 AND paymentType = 'advance') as balanceUsed,

                -- Exemption Check (0.00 but present)
                (SELECT COUNT(*) FROM canteen_fees 
                 WHERE studentID = s.studentID AND DATE(date) = DATE(?) 
                 AND paymentType = 'exempt') as isExempt,
                
                IFNULL((SELECT paymentType FROM canteen_fees 
                 WHERE studentID = s.studentID AND DATE(date) = DATE(?)
                 ORDER BY (CASE 
                    WHEN paymentType = 'advance_topup' THEN 1 
                    WHEN paymentType = 'daily' THEN 2 
                    WHEN paymentType = 'advance' THEN 3
                    WHEN paymentType = 'credit' THEN 4
                    WHEN paymentType = 'exempt' THEN 5
                    ELSE 6 END) ASC LIMIT 1), 'daily') as pTypes
                    
            FROM students s
            LEFT JOIN attendance a ON s.studentID = a.studentID AND DATE(a.date) = DATE(?)
            WHERE 1=1
        `;
        
        const params = [date, date, date, date, date, date];
        if (town && town !== 'All Towns' && town !== '') { 
            sql += " AND s.town = ?"; 
            params.push(town); 
        }

        sql += ` GROUP BY s.studentID 
                 HAVING inClass = 1 OR inCanteen = 1 OR cashReceived > 0 OR balanceUsed > 0 OR creditIncurred > 0 OR isExempt > 0
                 ORDER BY s.class ASC, name ASC`; 

        const [rows] = await db.query(sql, params);
        res.json({ success: true, date: date, data: rows });
    } catch (err) { 
        res.status(500).json({ success: false, message: "Internal Server Error" }); 
    }
});

// --- 2. WEEKLY SUMMARY REPORT ---
router.get('/reports/weekly', async (req, res) => {
    const { town, startDate, endDate } = req.query;

    try {
        let sql = `
            SELECT 
                s.town,
                COUNT(DISTINCT cf.studentID) as studentCount,
                -- Real Physical Cash
                SUM(CASE WHEN cf.paymentType IN ('daily', 'advance_topup') THEN cf.amount ELSE 0 END) as realCashIn,
                -- Digital Value (Advance Used)
                SUM(CASE WHEN cf.paymentType = 'advance' THEN cf.amount ELSE 0 END) as advanceDeductions,
                -- Debt Value (Credit)
                SUM(CASE WHEN cf.paymentType = 'credit' THEN cf.amount ELSE 0 END) as creditDebt,
                -- Free Meals (Exempted)
                SUM(CASE WHEN cf.paymentType = 'exempt' THEN 1 ELSE 0 END) as exemptCount
            FROM canteen_fees cf
            LEFT JOIN students s ON cf.studentID = s.studentID
            WHERE DATE(cf.date) >= DATE(?) AND DATE(cf.date) <= DATE(?)
        `;
        
        const params = [startDate, endDate];
        if (town && town !== 'All Towns' && town !== '') {
            sql += " AND s.town = ?";
            params.push(town);
        }

        sql += " GROUP BY s.town ORDER BY s.town ASC";
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Weekly report error" });
    }
});

// --- 3. MONTHLY REPORT ---
router.get('/reports/canteen/monthly', async (req, res) => {
    const { month, year } = req.query;
    try {
        const query = `
            SELECT 
                s.town,
                s.class,
                COUNT(DISTINCT cf.studentID) as studentsServed,
                -- Financial Breakdown
                SUM(CASE WHEN cf.paymentType IN ('daily', 'advance_topup') THEN cf.amount ELSE 0 END) as totalCashCollected,
                SUM(CASE WHEN cf.paymentType = 'advance' THEN cf.amount ELSE 0 END) as balanceValueConsumed,
                SUM(CASE WHEN cf.paymentType = 'credit' THEN cf.amount ELSE 0 END) as creditDebtIncurred,
                SUM(CASE WHEN cf.paymentType = 'exempt' THEN 1 ELSE 0 END) as totalExemptedServed
            FROM canteen_fees cf
            LEFT JOIN students s ON cf.studentID = s.studentID
            WHERE MONTH(cf.date) = ? AND YEAR(cf.date) = ?
            GROUP BY s.town, s.class
            ORDER BY s.town ASC, s.class ASC
        `;
        const [rows] = await db.query(query, [month, year]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Monthly report error" });
    }
});

// --- 4. YEARLY REPORT ---
router.get('/reports/canteen/yearly', async (req, res) => {
    const { year } = req.query;
    if (!year) return res.status(400).json({ message: 'Year is required' });

    try {
        const [rows] = await db.query(`
            SELECT 
                town,
                MONTHNAME(date) as month,
                MONTH(date) as monthNum,
                COUNT(DISTINCT studentID) as uniqueStudents,
                SUM(CASE WHEN paymentType IN ('daily', 'advance_topup') THEN amount ELSE 0 END) as cashCollected,
                SUM(CASE WHEN paymentType = 'advance' THEN amount ELSE 0 END) as balanceConsumed,
                SUM(CASE WHEN paymentType = 'credit' THEN amount ELSE 0 END) as debtIncurred,
                SUM(amount) as totalBusinessValue
            FROM canteen_fees 
            WHERE YEAR(date) = ?
            GROUP BY town, month, monthNum 
            ORDER BY monthNum ASC, town ASC`, 
            [year]
        );

        const [[stats]] = await db.query(`
            SELECT 
                SUM(CASE WHEN paymentType IN ('daily', 'advance_topup') THEN amount ELSE 0 END) as totalCash,
                SUM(CASE WHEN paymentType = 'advance' THEN amount ELSE 0 END) as totalLiabilityUsed,
                SUM(CASE WHEN paymentType = 'credit' THEN amount ELSE 0 END) as totalCreditDebt,
                COUNT(DISTINCT studentID) as totalStudentsServed
            FROM canteen_fees 
            WHERE YEAR(date) = ?`, 
            [year]
        );

        res.json({
            success: true,
            year: year,
            data: rows,
            stats: {
                grandTotalCash: stats.totalCash || 0,
                grandTotalConsumption: stats.totalLiabilityUsed || 0,
                grandTotalDebt: stats.totalCreditDebt || 0, // Frontend looks for grandTotalDebt
                totalStudents: stats.totalStudentsServed || 0
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Yearly report error' });
    }
});
// ==========================================
// 5. UTILITIES
// ==========================================

router.get('/towns', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT DISTINCT town FROM students WHERE town IS NOT NULL ORDER BY town");
        res.json(rows.map(r => r.town));
    } catch (err) { res.status(500).json({ message: 'Town fetch failed' }); }
});

module.exports = router;