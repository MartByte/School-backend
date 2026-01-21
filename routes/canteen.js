const express = require('express');
const router = express.Router();
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const CanteenFee = require('../models/CanteenFee');
const CanteenBalance = require('../models/CanteenBalance');
const CanteenCreditFlag = require('../models/CanteenCreditFlag');
const CanteenExemption = require('../models/CanteenExemption');

// ========== GET /canteen/collect ==========
router.get('/collect', async (req, res) => {
    const { town, date } = req.query;
    try {
        // 1. Fetch EVERYTHING from Atlas
        const students = await Student.find({ town });
        const attendanceRecords = await Attendance.find({ date, source: 'canteen' });
        const feeRecords = await CanteenFee.find({ date, town });
        
        // Fetch your separate collections
        const balances = await CanteenBalance.find({});
        const creditFlags = await CanteenCreditFlag.find({ active: 1 });
        const exemptions = await CanteenExemption.find({ active: 1 });

        const classes = students.reduce((acc, s) => {
            if (!acc[s.class]) acc[s.class] = { normal: [], advanced: [], credit: [], exempted: [] };

            // 2. "JOIN" the data manually using studentID
            const attn = attendanceRecords.find(a => a.studentID === s.studentID);
            const fee = feeRecords.find(f => f.studentID === s.studentID);
            
            const sBalance = balances.find(b => b.studentID === s.studentID);
            const isCredit = creditFlags.find(c => c.studentID === s.studentID);
            const isExempt = exemptions.find(e => e.studentID === s.studentID);

            const sData = {
                studentID: s.studentID, 
                Fname: s.fname || s.Fname, // Fixes "undefined"
                Lname: s.lname || s.Lname, 
                class: s.class,
                attendanceStatus: attn ? attn.status : null,
                paidAmount: fee ? fee.amount : 0,
                advance_balance: sBalance ? sBalance.balance : 0
            };

            // 3. Grouping Logic
            if (isExempt) acc[s.class].exempted.push(sData);
            else if (isCredit) acc[s.class].credit.push(sData);
            else if (sData.advance_balance > 0) acc[s.class].advanced.push(sData);
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
                
                // 1. HANDLE ABSENTEES (Reversing payments)
                if (!isPresentNow) {
                    const existingFee = await CanteenFee.findOneAndDelete({ studentID: s.studentID, date });
                    
                    // If they were advance/credit, REFUND the balance collection
                    if (existingFee && (existingFee.paymentType === 'advance' || existingFee.paymentType === 'credit')) {
                        await CanteenBalance.findOneAndUpdate(
                            { studentID: s.studentID }, 
                            { $inc: { balance: existingFee.amount } } // Refunding 'balance' field
                        );
                    }
                    await Attendance.findOneAndDelete({ studentID: s.studentID, date, source: 'canteen' });
                    continue;
                }

                // 2. HANDLE PRESENT STUDENTS
                let finalAmount = s.type === 'exempt' ? 0 : (amounts?.[s.studentID] || 5); 

                // Upsert Attendance
                await Attendance.findOneAndUpdate(
                    { studentID: s.studentID, date, source: 'canteen' },
                    { status: 'present', town },
                    { upsert: true }
                );

                const feeUpdate = { amount: finalAmount, collectedBy: collectorID, town, paymentType: s.type };
                
                // Try to find if a fee was already recorded today
                const oldFee = await CanteenFee.findOneAndUpdate(
                    { studentID: s.studentID, date }, 
                    feeUpdate, 
                    { upsert: false } // We don't upsert yet because we need to know if it existed
                );

                // 3. BALANCE DEDUCTION (Matches SQL logic)
                if (!oldFee) {
                    // This is a NEW collection for today
                    if (s.type === 'credit' || s.type === 'advance') {
                        await CanteenBalance.findOneAndUpdate(
                            { studentID: s.studentID }, 
                            { $inc: { balance: -finalAmount } }, // Deducting from balance collection
                            { upsert: true } // Creates record if it doesn't exist
                        );
                    }
                    // Now create the fee record since it didn't exist
                    await CanteenFee.create({ studentID: s.studentID, date, ...feeUpdate });
                }
            }
        }
        req.app.get('io')?.emit('refresh_data');
        res.json({ success: true });
    } catch (err) {
        console.error("POST Collect Error:", err);
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