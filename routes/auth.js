const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const multer = require('multer');
const jwt = require('jsonwebtoken'); // FIXED: Added this import
const pool = require('../db/connection');
const { generateResetCode, sendResetCodeSMS } = require('../utils/sendResetCode');
const { setResetCode, getResetCode, deleteResetCode } = require('../utils/resetCodeStore');
const isValidPhone = require('../utils/validatePhone');

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_12345';

// 1. Configure Storage to keep extensions
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const { userId } = req.params;
        const ext = path.extname(file.originalname);
        // This names the file based on the UserID (e.g., 200001.jpg)
        // This automatically "overwrites" the old reference in the logic
        cb(null, `${userId}${ext}`);
    }
});

const upload = multer({ 
    storage: storage, // Use our custom storage
    limits: { fileSize: 5 * 1024 * 1024 } 
});

// ========== UPLOAD PROFILE PICTURE ==========
router.post('/upload/profile-pic/:userId', upload.single('profilePic'), async (req, res) => {
    const { userId } = req.params;

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    try {
        // req.file.filename will now be "userID.jpg"
        const fileName = req.file.filename; 

        // Update the teacher's record in MySQL - Save only the filename
        const [result] = await pool.query(
            'UPDATE teachers SET profilePic = ? WHERE teacherID = ?',
            [fileName, userId]
        );

        if (result.affectedRows === 0) {
            await pool.query('UPDATE admins SET profilePic = ? WHERE adminID = ?', [fileName, userId]);
        }

        res.status(200).json({
            success: true,
            message: 'Profile picture updated!',
            data: { profilePic: fileName } // Send back the filename for the frontend
        });
    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});
// ========== REGISTER ==========
router.post('/register', async (req, res) => {
    const { Fname, Mname, Lname, userID, passwordHash, phone } = req.body;

    if (!Fname || !Lname || !userID || !passwordHash || !phone) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const formattedPhone = isValidPhone(phone);
    if (!formattedPhone) {
        return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    try {
        const hashedPassword = await bcrypt.hash(passwordHash, 10);
        const fName = Fname.trim().toLowerCase();
        const mName = (Mname || '').trim().toLowerCase();
        const lName = Lname.trim().toLowerCase();

        // Check Teachers
        const [teacher] = await pool.query(
            `SELECT * FROM teachers WHERE LOWER(TRIM(Fname)) = ? AND LOWER(TRIM(IFNULL(Mname, ''))) = ? AND LOWER(TRIM(Lname)) = ? AND teacherID = ?`,
            [fName, mName, lName, userID]
        );

        if (teacher.length > 0) {
            if (teacher[0].passwordHash) return res.status(400).json({ success: false, message: 'Teacher already registered' });
            await pool.query('UPDATE teachers SET passwordHash = ?, phone = ? WHERE teacherID = ?', [hashedPassword, formattedPhone, userID]);
            return res.status(200).json({ success: true, message: 'Teacher registered' });
        }

        // Check Admins
        const [admin] = await pool.query(
            `SELECT * FROM admins WHERE LOWER(TRIM(Fname)) = ? AND LOWER(TRIM(IFNULL(Mname, ''))) = ? AND LOWER(TRIM(Lname)) = ? AND adminID = ?`,
            [fName, mName, lName, userID]
        );

        if (admin.length > 0) {
            if (admin[0].passwordHash) return res.status(400).json({ success: false, message: 'Admin already registered' });
            await pool.query('UPDATE admins SET passwordHash = ?, phone = ? WHERE adminID = ?', [hashedPassword, formattedPhone, userID]);
            return res.status(200).json({ success: true, message: 'Admin registered' });
        }

        return res.status(404).json({ success: false, message: 'User not pre-listed' });

    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ========== LOGIN ==========
router.post('/login', async (req, res) => {
    const { id, passwordHash } = req.body;

    try {
        let dbUser = null;
        let role = '';

        // 1. Search Teachers
        const [teacher] = await pool.query('SELECT * FROM teachers WHERE teacherID = ?', [id]);
        if (teacher.length > 0) {
            dbUser = teacher[0];
            role = 'teacher';
        } else {
            // 2. Search Admins
            const [admin] = await pool.query('SELECT * FROM admins WHERE adminID = ?', [id]);
            if (admin.length > 0) {
                dbUser = admin[0];
                role = 'admin';
            }
        }

        // 3. User not found
        if (!dbUser) {
            return res.status(404).json({ success: false, message: 'User ID not recognized' });
        }

        // 4. Not Registered check
        if (!dbUser.passwordHash) {
            return res.status(200).json({
                success: false,
                data: {
                    requireRegistration: true,
                    message: 'Please complete your registration first.',
                    id: id,
                    role: role,
                    fullName: `${dbUser.Fname} ${dbUser.Lname}`
                }
            });
        }

        // 5. Password Check
        const isMatch = await bcrypt.compare(passwordHash, dbUser.passwordHash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Incorrect password' });
        }

        // 6. Token Generation
        // Use a fallback secret if process.env.JWT_SECRET is missing to prevent crash
        const secret = JWT_SECRET || 'dev_secret_key_123';
        const token = jwt.sign(
            { id: id, role: role },
            secret,
            { expiresIn: '30d' }
        );

        // 7. Success Response
        // Crucial: We ensure 'id' is sent back so the frontend doesn't get 'undefined'
        // In your Backend (auth.js)
res.status(200).json({
    success: true,
    data: {
        token: token,
        user: {
            id: id,
            role: role,
            teacherID: dbUser.teacherID || null,
            adminID: dbUser.adminID || null,
            town: dbUser.town || '',     // Critical for Canteen/Attendance
            class: dbUser.class || '',   // Useful for Teachers
            Fname: dbUser.Fname,
            Lname: dbUser.Lname,
            phone: dbUser.phone
        }
    }
});
    } catch (err) {
        // Look at your VS Code terminal to see what this prints!
        console.error('CRITICAL LOGIN ERROR:', err);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
});

// ========== TEACHER DASHBOARD INFO ==========
router.get('/teacher/:id', async (req, res) => {
    const { id } = req.params;
    const API_BASE_URL = 'http://64.226.65.95';

    try {
        const [rows] = await pool.query(
            'SELECT Fname, Mname, Lname, assignedClass, isCanteenCollector, town, profilePic FROM teachers WHERE teacherID = ?',
            [id]
        );

        if (rows.length === 0) return res.status(404).json({ message: 'Teacher not found' });

        const teacher = rows[0];
        let profilePic = teacher.profilePic;

        // Clean up filename
        if (profilePic) {
            profilePic = profilePic.replace('uploads/', '').split('/').pop();
        }

        res.status(200).json({
            Fname: teacher.Fname ?? '',
            Mname: teacher.Mname ?? '',
            Lname: teacher.Lname ?? '',
            town: teacher.town || null,
            assignedClass: teacher.assignedClass || null,
            isCanteenCollector: teacher.isCanteenCollector || 0,
            profilePicUrl: profilePic ? `${API_BASE_URL}/uploads/${profilePic}` : null
        });
    } catch (err) {
        console.error('Fetch teacher dashboard error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ========== REQUEST PASSWORD RESET ==========
router.post('/request-password-reset', async (req, res) => {
    const { id, phone } = req.body;

    if (!id || !phone) return res.status(400).json({ message: 'Missing ID or phone number' });

    const formattedPhone = isValidPhone(phone);
    if (!formattedPhone) return res.status(400).json({ message: 'Invalid phone format' });

    try {
        const [teacherRows] = await pool.query('SELECT * FROM teachers WHERE teacherID = ? AND phone = ?', [id, formattedPhone]);
        const [adminRows] = await pool.query('SELECT * FROM admins WHERE adminID = ? AND phone = ?', [id, formattedPhone]);

        const user = teacherRows[0] || adminRows[0];

        if (!user) return res.status(404).json({ message: 'User not found or phone mismatch' });

        const resetCode = generateResetCode();
        await sendResetCodeSMS(formattedPhone, resetCode);

        // Use the imported function from your utils
        await setResetCode(id, resetCode);

        res.status(200).json({ message: 'Reset code sent via SMS' });
    } catch (err) {
        console.error('Reset error:', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ========== VERIFY RESET CODE ==========
router.post('/verify-reset-code', async (req, res) => {
    const { id, code, newPassword } = req.body;

    if (!id || !code || !newPassword) return res.status(400).json({ message: 'Missing fields' });

    try {
        const stored = await getResetCode(id);

        if (!stored || stored.code !== code) {
            return res.status(400).json({ message: 'Invalid or expired code' });
        }

        if (new Date() > new Date(stored.expires_at)) {
            await deleteResetCode(id);
            return res.status(400).json({ message: 'Code has expired' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update both just in case, or track role
        await pool.query('UPDATE teachers SET passwordHash = ? WHERE teacherID = ?', [hashedPassword, id]);
        await pool.query('UPDATE admins SET passwordHash = ? WHERE adminID = ?', [hashedPassword, id]);

        await deleteResetCode(id);
        res.status(200).json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});


// Add this to auth.js to force errors to show up
router.use((err, req, res, next) => {
    console.error("GLOBAL ERROR:", err.stack);
    res.status(500).json({ success: false, message: "Internal Server Error" });
});

module.exports = router;