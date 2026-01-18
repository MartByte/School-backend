const pool = require('../db/connection');

// Store reset code in DB
async function setResetCode(id, code) {
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Upsert: Insert or update
    await pool.query(`
        INSERT INTO reset_codes (id, code, expires_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE code = ?, expires_at = ?;
    `, [id, code, expiresAt, code, expiresAt]);
}

// Retrieve reset code
async function getResetCode(id) {
    const [rows] = await pool.query('SELECT code, expires_at FROM reset_codes WHERE id = ?', [id]);
    if (rows.length === 0) return null;

    return {
        code: rows[0].code,
        expiresAt: rows[0].expires_at
    };
}

// Delete reset code
async function deleteResetCode(id) {
    await pool.query('DELETE FROM reset_codes WHERE id = ?', [id]);
}

module.exports = {
    setResetCode,
    getResetCode,
    deleteResetCode
};
