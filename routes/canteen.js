const express = require('express');
const router = express.Router();
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const CanteenFee = require('../models/CanteenFee');

// ========== GET /canteen/collect ==========
router.get('/collect', async (req, res) => {
    const { town, date } = req.query;
    if (!town || !date) return res.status(400).json({ success: false, message: "Missing data" });

    try {
        const students = await Student.find({ town });
        const attendanceRecords = await Attendance.find({ date, source: 'canteen' });
        const feeRecords = await CanteenFee.find({ date, town });

        const classes = students.reduce((acc, s) => {
            if (!acc[s.class]) acc[s.class] = { normal: [], advanced: [], credit: [], exempted: [] };

            const attn = attendanceRecords.find(a => a.studentID === s.studentID);
            const fee = feeRecords.find(f => f.studentID === s.studentID);

            const sData = {
                studentID: s.studentID, Fname: s.Fname, Lname: s.Lname, 
                class: s.class, town: s.town,
                attendanceStatus: attn ? attn.status : null,
                paidAmount: fee ? fee.amount : 0,
                advance_balance: s.advanceBalance
            };

            if (s.isExempted) acc[s.class].exempted.push(sData);
            else if (s.isCredit) acc[s.class].credit.push(sData);
            else if (s.advanceBalance > 0) acc[s.class].advanced.push(sData);
            else acc[s.class].normal.push(sData);

            return acc;
        }, {});

        res.json({ success: true, data: { classes } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== POST /canteen/collect ==========
router.post('/collect', async (req, res) => {
    const { town, date, classData, attendance, amounts, collectedBy } = req.body;
    const collectorID = collectedBy || req.body.adminID || req.body.userId;

    try {
        for (const [className, categories] of Object.entries(classData)) {
            const allStudents = [
                ...(categories.normal || []).map(s => ({ ...s, type: 'daily' })),
                ...(categories.advanced || []).map(s => ({ ...s, type: 'advance' })),
                ...(categories.credit || []).map(s => ({ ...s, type: 'credit' })),
                ...(categories.exempted || []).map(s => ({ ...s, type: 'exempt' }))
            ];

            for (const s of allStudents) {
                const isPresentNow = !!attendance[s.studentID];
                
                // 1. Handle Absentees/Reversals
                if (!isPresentNow) {
                    const existingFee = await CanteenFee.findOneAndDelete({ studentID: s.studentID, date });
                    if (existingFee && (existingFee.paymentType === 'advance' || existingFee.paymentType === 'credit')) {
                        await Student.findOneAndUpdate({ studentID: s.studentID }, { $inc: { advanceBalance: existingFee.amount } });
                    }
                    await Attendance.findOneAndDelete({ studentID: s.studentID, date, source: 'canteen' });
                    continue;
                }

                // 2. Handle Present Students (Upsert)
                let finalAmount = s.type === 'exempt' ? 0 : (amounts?.[s.studentID] || 5); // Default 5 if daily fee missing

                await Attendance.findOneAndUpdate(
                    { studentID: s.studentID, date, source: 'canteen' },
                    { status: 'present', town },
                    { upsert: true }
                );

                const feeUpdate = { amount: finalAmount, collectedBy: collectorID, town, paymentType: s.type };
                const oldFee = await CanteenFee.findOneAndUpdate({ studentID: s.studentID, date }, feeUpdate, { upsert: true });

                // If first time recording today and it's credit/advance, deduct from student balance
                if (!oldFee && (s.type === 'credit' || s.type === 'advance')) {
                    await Student.findOneAndUpdate({ studentID: s.studentID }, { $inc: { advanceBalance: -finalAmount } });
                }
            }
        }
        req.app.get('io')?.emit('refresh_data');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== POST /canteen/advance/topup ==========
router.post('/advance/topup', async (req, res) => {
    const { studentID, amount, collectedBy, town } = req.body;
    try {
        await Student.findOneAndUpdate({ studentID }, { $inc: { advanceBalance: amount } });
        await CanteenFee.create({ studentID, amount, date: new Date(), collectedBy, town, paymentType: 'advance_topup' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== POST /canteen/student/move-group ==========
router.post('/student/move-group', async (req, res) => {
    const { studentID, toGroup, advanceAmount } = req.body;
    try {
        const update = {
            isCredit: toGroup === 'credit',
            isExempted: toGroup === 'exempted',
        };
        if (toGroup === 'advanced') update.$inc = { advanceBalance: parseFloat(advanceAmount) || 0 };
        else if (toGroup === 'normal') update.advanceBalance = 0;

        await Student.findOneAndUpdate({ studentID }, update);
        req.app.get('io')?.emit('refresh_data');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== GET /canteen/students/town/:town ==========
router.get('/students/town/:town', async (req, res) => {
    try {
        const filter = req.params.town === 'all' ? {} : { town: req.params.town };
        const students = await Student.find(filter).sort({ class: 1, Fname: 1 });
        res.json({ success: true, data: students });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


/**
 * POST /canteen/credit/flag
 * Body: { studentID, active: boolean }
 */
router.post('/credit/flag', async (req, res) => {
    const { studentID, active } = req.body;
    if (!studentID || typeof active !== 'boolean') {
        return res.status(400).json({ message: 'studentID and active are required' });
    }
    try {
        // In Mongo, we just update the field on the student directly
        await Student.findOneAndUpdate({ studentID }, { isCredit: active });
        
        res.json({ success: true });
        req.app.get('io')?.emit('refresh_data', { message: 'Credit status updated' });
    } catch (err) {
        console.error('POST /credit/flag error', err);
        res.status(500).json({ message: 'Failed to update credit flag' });
    }
});

/**
 * POST /canteen/exempt/flag
 * Body: { studentID, active: boolean }
 */
router.post('/exempt/flag', async (req, res) => {
    const { studentID, active } = req.body;
    if (!studentID || typeof active !== 'boolean') {
        return res.status(400).json({ message: 'studentID and active are required' });
    }
    try {
        // Toggle the isExempted field
        await Student.findOneAndUpdate({ studentID }, { isExempted: active });
        
        res.json({ success: true });
        req.app.get('io')?.emit('refresh_data', { message: 'Exemption status updated' });
    } catch (err) {
        console.error('POST /exempt/flag error', err);
        res.status(500).json({ message: 'Failed to update exempt flag' });
    }
});

module.exports = router;