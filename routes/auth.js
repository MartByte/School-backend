const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Teacher = require('../models/Teacher'); 
const Admin = require('../models/Admin');
const isValidPhone = require('../utils/validatePhone');
const { generateResetCode, sendResetCodeSMS } = require('../utils/sendResetCode');
const { setResetCode, getResetCode, deleteResetCode } = require('../utils/resetCodeStore');

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_12345';
const API_BASE_URL = process.env.API_BASE_URL || 'https://fees-system-backend.onrender.com';

// ========== REGISTER ==========
router.post('/register', async (req, res) => {
    const { Fname, Mname, Lname, userID, passwordHash, phone } = req.body;
    if (!Fname || !Lname || !userID || !passwordHash || !phone) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const formattedPhone = isValidPhone(phone);
    if (!formattedPhone) return res.status(400).json({ success: false, message: 'Invalid phone' });

    try {
        const hashedPassword = await bcrypt.hash(passwordHash, 10);
        // Find by ID and check names case-insensitively
        let user = await Teacher.findOne({ teacherID: userID }) || await Admin.findOne({ adminID: userID });

        if (!user) return res.status(404).json({ success: false, message: 'User not pre-listed' });
        if (user.passwordHash) return res.status(400).json({ success: false, message: 'Already registered' });

        // Update and save
        user.passwordHash = hashedPassword;
        user.phone = formattedPhone;
        await user.save();

        res.status(200).json({ success: true, message: 'Registration successful' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ========== LOGIN ==========
router.post('/login', async (req, res) => {
    const { id, passwordHash } = req.body; 
    try {
        const dbUser = await Teacher.findOne({ teacherID: id }) || await Admin.findOne({ adminID: id });
        if (!dbUser) return res.status(404).json({ success: false, message: 'User not found' });

        const role = dbUser.teacherID ? 'teacher' : 'admin';

        if (!dbUser.passwordHash) {
            return res.status(200).json({ 
                success: false, 
                data: { requireRegistration: true, id, role, fullName: `${dbUser.Fname} ${dbUser.Lname}` }
            });
        }

        const isMatch = await bcrypt.compare(passwordHash, dbUser.passwordHash);
        if (!isMatch) return res.status(401).json({ success: false, message: 'Incorrect password' });

        const token = jwt.sign({ id, role }, JWT_SECRET, { expiresIn: '30d' });

        res.status(200).json({
            success: true,
            data: { token, user: { id, role, Fname: dbUser.Fname, Lname: dbUser.Lname, town: dbUser.town } }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ========== TEACHER DASHBOARD INFO ==========
router.get('/teacher/:id', async (req, res) => {
    try {
        const teacher = await Teacher.findOne({ teacherID: req.params.id });
        if (!teacher) return res.status(404).json({ message: 'Teacher not found' });

        // Handle profile picture URL logic
        let profilePicUrl = null;
        if (teacher.profilePic) {
            const fileName = teacher.profilePic.split('/').pop();
            profilePicUrl = `${API_BASE_URL}/uploads/${fileName}`;
        }

        res.status(200).json({
            Fname: teacher.Fname || '',
            Lname: teacher.Lname || '',
            town: teacher.town || null,
            assignedClass: teacher.assignedClass || null,
            isCanteenCollector: teacher.isCanteenCollector || false,
            profilePicUrl
        });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ========== REQUEST PASSWORD RESET ==========
router.post('/request-password-reset', async (req, res) => {
    const { id, phone } = req.body;
    const formattedPhone = isValidPhone(phone);

    try {
        const user = await Teacher.findOne({ teacherID: id, phone: formattedPhone }) || 
                     await Admin.findOne({ adminID: id, phone: formattedPhone });

        if (!user) return res.status(404).json({ message: 'User/Phone mismatch' });

        const resetCode = generateResetCode();
        await sendResetCodeSMS(formattedPhone, resetCode);
        await setResetCode(id, resetCode); 

        res.status(200).json({ message: 'Reset code sent via SMS' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ========== VERIFY RESET CODE & UPDATE PASSWORD ==========
router.post('/verify-reset-code', async (req, res) => {
    const { id, code, newPassword } = req.body;
    try {
        const stored = await getResetCode(id);
        if (!stored || stored.code !== code || new Date() > new Date(stored.expires_at)) {
            return res.status(400).json({ message: 'Invalid or expired code' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // Update whoever matches that ID
        await Teacher.findOneAndUpdate({ teacherID: id }, { passwordHash: hashedPassword });
        await Admin.findOneAndUpdate({ adminID: id }, { passwordHash: hashedPassword });

        await deleteResetCode(id);
        res.status(200).json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;