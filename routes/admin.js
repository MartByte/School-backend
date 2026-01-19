const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Attendance = require('../models/Attendance');
const CanteenFee = require('../models/CanteenFee');
const isValidPhone = require('../utils/validatePhone');

// Multer Setup
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, `img_${Date.now()}${path.extname(file.originalname)}`);
    },
});
const upload = multer({ storage });

// ID Generator Helper
const generateID = async (type) => {
    const year = new Date().getFullYear();
    const prefix = type === 'student' ? 'STD' : 'TCH';
    const count = type === 'student' ? await Student.countDocuments() : await Teacher.countDocuments();
    return `${prefix}-${year}-${(count + 1).toString().padStart(4, '0')}`;
};

// ==========================================
// 1. STUDENT MANAGEMENT (5 Endpoints)
// ==========================================

// 1. GET students by class
router.get('/by-town/:townName', async (req, res) => {
    try {
        const searchTown = req.params.townName.trim(); // Remove spaces from the user input
        
        const students = await Student.find({ 
            town: { $regex: new RegExp(searchTown, "i") }, 
            isDeleted: 0 
        }).sort({ lname: 1 });

        console.log(`Searching for town: ${searchTown}. Found: ${students.length}`);

        res.json(students.map(s => ({ 
            studentID: s.studentID, 
            fullName: `${s.fname} ${s.lname}`,
            town: s.town, 
            class: s.class 
        })));
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 2. POST add student
router.post('/students/add', upload.single('profilePic'), async (req, res) => {
    const { Fname, Mname, Lname, class: className, town, guardianPhone } = req.body;
    const validP = isValidPhone(guardianPhone);
    if (!validP) return res.status(400).json({ success: false, message: 'Invalid phone' });
    try {
        const studentID = await generateID('student');
        const s = new Student({ studentID, Fname, Mname, Lname, class: className, town, guardianPhone: validP, profilePic: req.file?.filename });
        await s.save();
        req.app.get('io')?.emit('refresh_data');
        res.status(201).json({ success: true, studentID });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 3. GET students by town
router.get('/by-town/:townName', async (req, res) => {
    try {
        // The 'i' flag makes the search case-insensitive
        const students = await Student.find({ 
            town: { $regex: new RegExp(req.params.townName, "i") }, 
            isDeleted: 0 
        }).sort({ Lname: 1 });

        res.json(students.map(s => ({ 
            studentID: s.studentID, 
            fullName: `${s.fname} ${s.lname}`, // Ensure these match your schema's casing
            town: s.town, 
            class: s.class 
        })));
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 4. GET all students
router.get('/students/all', async (req, res) => {
    try {
        const students = await Student.find().sort({ lname: 1 });
        res.json(students);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 5. PUT edit student
router.put('/students/edit/:studentID', async (req, res) => {
    try {
        await Student.findOneAndUpdate({ studentID: req.params.studentID }, req.body);
        res.json({ message: 'Student updated' });
    } catch (err) { res.status(500).json({ message: 'Update failed' }); }
});

// ==========================================
// 2. TEACHER MANAGEMENT (4 Endpoints)
// ==========================================

// 6. GET all teachers
router.get('/all/teachers', async (req, res) => {
    try {
        // Change false to 0 to match the migrated SQL data
        const teachers = await Teacher.find({ isDeleted: 0 }).sort({ lname: 1 });
        
        // Match the lowercase keys in your .map()
        res.json(teachers.map(t => ({ 
            ...t._doc, 
            fullName: `${t.fname} ${t.mname ? t.mname + ' ' : ''}${t.lname}` 
        })));
    } catch (err) { 
        res.status(500).json({ message: err.message }); 
    }
});



// 7. POST add teacher
router.post('/add-teacher', upload.single('profilePic'), async (req, res) => {
    try {
        const teacherID = await generateID('teacher');
        const t = new Teacher({ ...req.body, teacherID, profilePic: req.file?.filename });
        await t.save();
        res.status(200).json({ success: true, teacherID });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// 8. GET teacher attendance
router.get('/teachers/attendance', async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
        const teachers = await Teacher.find({ isDeleted: false });
        const rows = await Promise.all(teachers.map(async (t) => {
            const a = await Attendance.findOne({ teacherID: t.teacherID, date, source: 'staff' });
            return { teacherID: t.teacherID, Fname: t.Fname, Lname: t.Lname, status: a?.status || null };
        }));
        res.json(rows);
    } catch (err) { res.status(500).json({ message: 'Fetch failed' }); }
});

// 9. POST teacher attendance
router.post('/teachers/attendance', async (req, res) => {
    const { attendanceList, date } = req.body;
    try {
        for (const record of attendanceList) {
            await Attendance.findOneAndUpdate(
                { teacherID: record.teacherID, date, source: 'staff' },
                { status: record.status, markedBy: record.markedBy },
                { upsert: true }
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// ==========================================
// 3. DASHBOARD & STATS (3 Endpoints)
// ==========================================

// 10. POST admin summary (The Main Dashboard)
router.post('/dashboard/admin-summary', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const [s, t, rev, classP, cStats] = await Promise.all([
            Student.countDocuments({ isDeleted: false }),
            Teacher.countDocuments({ isDeleted: false }),
            CanteenFee.aggregate([{ $match: { date: today, paymentType: { $in: ['daily', 'advance_topup'] } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
            Attendance.countDocuments({ date: today, source: 'class', status: 'present' }),
            CanteenFee.aggregate([{ $match: { date: today, paymentType: { $ne: 'advance_topup' } } }, { $group: { _id: null, daily: { $sum: { $cond: [{ $eq: ["$paymentType", "daily"] }, 1, 0] } }, adv: { $sum: { $cond: [{ $eq: ["$paymentType", "advance"] }, 1, 0] } }, credit: { $sum: { $cond: [{ $eq: ["$paymentType", "credit"] }, 1, 0] } }, total: { $sum: 1 } } }])
        ]);
        const cs = cStats[0] || {};
        res.json({ totalStudents: s, totalTeachers: t, totalCollected: rev[0]?.total || 0, canteenPresent: cs.total || 0, classPresent: classP, dailyCount: cs.daily || 0, advanceCount: cs.adv || 0, debitCount: cs.credit || 0, missedCanteen: classP - (cs.total || 0) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 11. GET global stats
router.get('/global-stats', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const present = await Attendance.countDocuments({ date: today, status: 'present' });
        const revenue = await CanteenFee.aggregate([{ $match: { date: today } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        res.json({ success: true, data: { totalStudents: await Student.countDocuments(), presentToday: present, revenue: revenue[0]?.total || 0 } });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 12. GET attendance summary (By Class)
router.get('/attendance-summary', async (req, res) => {
    const { date } = req.query;
    try {
        const summary = await Student.aggregate([
            { $group: { _id: "$class", total_students: { $sum: 1 } } },
            { $lookup: { from: "attendances", let: { cls: "$_id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$class", "$$cls"] }, { $eq: ["$date", date] }, { $eq: ["$status", "present"] }] } } }], as: "p" } },
            { $project: { class: "$_id", total_students: 1, present_count: { $size: "$p" } } },
            { $sort: { class: 1 } }
        ]);
        res.json({ success: true, data: summary });
    } catch (err) { res.status(500).json({ success: false }); }
});

// ==========================================
// 4. REPORTS & AUDITS (6 Endpoints)
// ==========================================

// 13. GET audit gap details
router.get('/reports/audit-gap-details', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const presentIDs = await Attendance.find({ date: today, source: 'class', status: 'present' }).distinct('studentID');
        const fedIDs = await CanteenFee.find({ date: today }).distinct('studentID');
        const gapIDs = presentIDs.filter(id => !fedIDs.includes(id));
        const students = await Student.find({ studentID: { $in: gapIDs } });
        res.json({ success: true, data: students.map(s => ({ studentID: s.studentID, name: `${s.Fname} ${s.Lname}`, class: s.class, town: s.town })) });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 14. GET balances report
router.get('/reports/balances', async (req, res) => {
    try {
        const students = await Student.find({ $or: [{ advanceBalance: { $ne: 0 } }, { isCredit: true }] });
        res.json({ success: true, data: students.map(s => ({ studentID: s.studentID, name: `${s.Fname} ${s.Lname}`, class: s.class, town: s.town, balance: s.advanceBalance, is_credit: s.isCredit ? 1 : 0 })) });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 15. GET daily report
router.get('/reports/canteen/daily', async (req, res) => {
    const date = req.query.date?.split('T')[0] || new Date().toISOString().split('T')[0];
    try {
        const fees = await CanteenFee.find({ date });
        const data = await Promise.all(fees.map(async (f) => {
            const s = await Student.findOne({ studentID: f.studentID });
            return { studentID: f.studentID, name: `${s?.Fname} ${s?.Lname}`, class: s?.class, town: s?.town, cashReceived: f.paymentType === 'daily' ? f.amount : 0, creditIncurred: f.paymentType === 'credit' ? f.amount : 0, balanceUsed: f.paymentType === 'advance' ? f.amount : 0, pTypes: f.paymentType };
        }));
        res.json({ success: true, date, data });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 16. GET weekly report
router.get('/reports/weekly', async (req, res) => {
    const { startDate, endDate } = req.query;
    try {
        const report = await CanteenFee.aggregate([
            { $match: { date: { $gte: startDate, $lte: endDate } } },
            { $group: { _id: "$town", studentCount: { $addToSet: "$studentID" }, realCashIn: { $sum: { $cond: [{ $in: ["$paymentType", ["daily", "advance_topup"]] }, "$amount", 0] } }, advanceDeductions: { $sum: { $cond: [{ $eq: ["$paymentType", "advance"] }, "$amount", 0] } }, creditDebt: { $sum: { $cond: [{ $eq: ["$paymentType", "credit"] }, "$amount", 0] } } } },
            { $project: { town: "$_id", studentCount: { $size: "$studentCount" }, realCashIn: 1, advanceDeductions: 1, creditDebt: 1 } }
        ]);
        res.json({ success: true, data: report });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 17. GET monthly report
router.get('/reports/canteen/monthly', async (req, res) => {
    const { month, year } = req.query;
    try {
        const start = `${year}-${month.padStart(2, '0')}-01`;
        const end = `${year}-${month.padStart(2, '0')}-31`;
        const data = await CanteenFee.aggregate([
            { $match: { date: { $gte: start, $lte: end } } },
            { $group: { _id: { town: "$town", class: "$class" }, studentsServed: { $addToSet: "$studentID" }, totalCashCollected: { $sum: { $cond: [{ $in: ["$paymentType", ["daily", "advance_topup"]] }, "$amount", 0] } } } },
            { $project: { town: "$_id.town", class: "$_id.class", studentsServed: { $size: "$studentsServed" }, totalCashCollected: 1 } }
        ]);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 18. GET yearly report
router.get('/reports/canteen/yearly', async (req, res) => {
    const { year } = req.query;
    try {
        const data = await CanteenFee.aggregate([
            { $match: { date: { $regex: `^${year}` } } },
            { $group: { _id: { town: "$town", month: { $substr: ["$date", 5, 2] } }, cashCollected: { $sum: "$amount" }, uniqueStudents: { $addToSet: "$studentID" } } },
            { $project: { town: "$_id.town", month: "$_id.month", cashCollected: 1, uniqueStudents: { $size: "$uniqueStudents" } } }
        ]);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 19. GET towns (Utility)
router.get('/towns', async (req, res) => {
    try {
        const towns = await Student.distinct('town');
        res.json(towns);
    } catch (err) { res.status(500).json({ message: 'Failed' }); }
});

module.exports = router;