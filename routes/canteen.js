const express = require('express');
const router = express.Router();
const db = require('../db/connection');

/**
  * GET /canteen/collect?town=...&date=YYYY-MM-DD
  * Returns: { town, date, dailyFee, classes: [{ class, groups:{ normal[], advance[], credit[], exempted[] } }] }
  */


router.get('/collect', async (req, res) => {
    const { town, date } = req.query;

    if (!town || !date) {
        return res.status(400).json({ success: false, message: "Town and date are required." });
    }

    try {
        const [rows] = await db.query(`
            SELECT 
                s.studentID, s.Fname, s.Lname, s.class, s.town,
                a.status as attendanceStatus,
                cf.amount as paidAmount,
                cf.paymentType as lastPaymentType,
                cb.balance as advance_balance,
                IFNULL(c_flag.active, 0) as is_credit,
                IFNULL(ce.active, 0) as is_exempted
            FROM students s
            LEFT JOIN attendance a ON s.studentID = a.studentID AND a.date = ? AND a.source = 'canteen'
            LEFT JOIN canteen_fees cf ON s.studentID = cf.studentID AND cf.date = ?
            LEFT JOIN canteen_balances cb ON s.studentID = cb.studentID
            LEFT JOIN canteen_credit_flags c_flag ON s.studentID = c_flag.studentID
            LEFT JOIN canteen_exemptions ce ON s.studentID = ce.studentID
            WHERE s.town = ?
        `, [date, date, town]);

        const classes = rows.reduce((acc, row) => {
            if (!acc[row.class]) {
                acc[row.class] = { normal: [], advanced: [], credit: [], exempted: [] };
            }

            // Categorization Logic
            if (row.is_exempted === 1) {
                acc[row.class].exempted.push(row);
            } else if (row.is_credit === 1) {
                acc[row.class].credit.push(row);
            } else if (row.advance_balance > 0) {
                acc[row.class].advanced.push(row);
            } else {
                acc[row.class].normal.push(row);
            }
            return acc;
        }, {});

        res.json({ success: true, data: { classes } });
    } catch (err) {
        console.error("GET Collect Error:", err);
        res.status(500).json({ success: false, message: "Database error" });
    }
});

/**
  * POST /canteen/collect
  * Body: { town, date, classData: { className: { normal: [], advanced: [], credit: [], exempted: [] } }, attendance: {}, amounts: {}, collectedBy: number }
  */

router.post('/collect', async (req, res) => {
    const { town, date, classData, attendance, amounts, collectedBy } = req.body;
    const finalCollectorID = collectedBy || req.body.adminID || req.body.userId;

    if (!finalCollectorID) {
        return res.status(400).json({ success: false, message: "Security Error: No Collector ID found." });
    }

    let conn;
    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        const [feeRow] = await conn.query('SELECT daily_fee FROM town_fees WHERE town = ?', [town]);
        const dailyFee = Number(feeRow[0]?.daily_fee || 0);

        for (const [className, categories] of Object.entries(classData)) {
            const allStudents = [
                ...(categories.normal || []).map(s => ({ ...s, type: 'daily' })),
                ...(categories.advanced || []).map(s => ({ ...s, type: 'advance' })),
                ...(categories.credit || []).map(s => ({ ...s, type: 'credit' })),
                ...(categories.exempted || []).map(s => ({ ...s, type: 'exempt' }))
            ];

            for (const student of allStudents) {
                const isPresentNow = !!attendance[student.studentID];

                // 1. Fetch current database state for this student today
                const [existing] = await conn.query(
                    `SELECT amount, paymentType FROM canteen_fees WHERE studentID = ? AND date = ?`,
                    [student.studentID, date]
                );
                const hasExistingRecord = existing.length > 0;

                // --- CASE A: STUDENT IS ABSENT (UNCHECKED) ---
                if (!isPresentNow) {
                    if (hasExistingRecord) {
                        const prevAmount = existing[0].amount;
                        const prevType = existing[0].paymentType;

                        // Refund if they were Advance or Credit
                        if (prevType === 'advance' || prevType === 'credit') {
                            await conn.query(
                                `UPDATE canteen_balances SET balance = balance + ? WHERE studentID = ?`,
                                [prevAmount, student.studentID]
                            );
                        }
                        // Remove records
                        await conn.query(`DELETE FROM canteen_fees WHERE studentID = ? AND date = ?`, [student.studentID, date]);
                        await conn.query(`DELETE FROM attendance WHERE studentID = ? AND date = ? AND source = 'canteen'`, [student.studentID, date]);
                    }
                    continue; 
                }

                // --- CASE B: STUDENT IS PRESENT (CHECKED) ---
                let finalAmount = student.type === 'exempt' ? 0 : dailyFee;
                if (amounts && amounts[student.studentID] !== undefined) {
                    finalAmount = Number(amounts[student.studentID]);
                }

                // IMPORTANT: Only deduct balance if this is a NEW marking (prevent double-charging)
                if (!hasExistingRecord) {
                    if (student.type === 'credit' || student.type === 'advance') {
                        await conn.query(`
                            INSERT INTO canteen_balances (studentID, balance)
                            VALUES (?, -?)
                            ON DUPLICATE KEY UPDATE balance = balance - ?`,
                            [student.studentID, finalAmount, finalAmount]
                        );
                    }
                }

                // Upsert Attendance
                await conn.query(`
                    INSERT INTO attendance (studentID, date, status, source)
                    VALUES (?, ?, 'present', 'canteen')
                    ON DUPLICATE KEY UPDATE status = 'present'`,
                    [student.studentID, date]
                );

                // Upsert Fees
                await conn.query(`
                    INSERT INTO canteen_fees (studentID, amount, date, collectedBy, town, paymentType)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        amount = VALUES(amount), 
                        paymentType = VALUES(paymentType),
                        collectedBy = VALUES(collectedBy)`,
                    [student.studentID, finalAmount, date, finalCollectorID, town, student.type]
                );
            }
        }

        await conn.commit();
        req.app.get('io')?.emit('refresh_data');
        res.json({ success: true });

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("POST Collect Error:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});


/**
  * POST /canteen/advance/topup
  * Body: { studentID, amount }
  */
router.post('/advance/topup', async (req, res) => {
      // LOG 1: If you don't see this, the URL or Middleware is the problem
      console.log(">>> [TOPUP] Incoming Request Body:", req.body);

      const { studentID, amount, collectedBy, town } = req.body;

      try {
            // Ensure data exists before starting transaction
            if (!studentID || !amount) {
                  console.log(">>> [TOPUP] Failed: Missing StudentID or Amount");
                  return res.status(400).json({ success: false, message: "Missing required fields" });
            }

            await db.query('START TRANSACTION');

            // 1. Update Wallet (studentID is INT, amount is DECIMAL)
            await db.query(`
                  INSERT INTO canteen_balances (studentID, balance)
                  VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + ?`,
                  [Number(studentID), Number(amount), Number(amount)]
            );

            // 2. Record Cash Entry (collectedBy is VARCHAR, date is DATETIME)
            // We use NOW() to satisfy the unique_fee_datetime constraint
            await db.query(`
                  INSERT INTO canteen_fees (studentID, amount, date, collectedBy, town, paymentType)
                  VALUES (?, ?, NOW(), ?, ?, 'advance_topup')`,
                  [Number(studentID), Number(amount), String(collectedBy), town]
            );

            await db.query('COMMIT');
            console.log(">>> [TOPUP] Success for Student ID:", studentID);
            res.json({ success: true });

      } catch (err) {
            if (db) await db.query('ROLLBACK');
            // This log will reveal if it's a Foreign Key or Duplicate error
            console.error(">>> [TOPUP] SQL ERROR:", err.sqlMessage || err.message);
            res.status(500).json({ success: false, message: err.sqlMessage || 'Server Error' });
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
      const [row] = await db.query('SELECT studentID FROM canteen_credit_flags WHERE studentID = ?', [studentID]);
      if (row.length) {
         await db.query('UPDATE canteen_credit_flags SET active = ? WHERE studentID = ?', [active ? 1 : 0, studentID]);
      } else {
         await db.query('INSERT INTO canteen_credit_flags (studentID, active) VALUES (?, ?)', [studentID, active ? 1 : 0]);
      }
      res.json({ success: true });
      const io = req.app.get('io');
io.emit('refresh_data', { message: 'New activity detected' });
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
      const [row] = await db.query('SELECT studentID FROM canteen_exemptions WHERE studentID = ?', [studentID]);
      if (row.length) {
         await db.query('UPDATE canteen_exemptions SET active = ? WHERE studentID = ?', [active ? 1 : 0, studentID]);
      } else {
         await db.query('INSERT INTO canteen_exemptions (studentID, active) VALUES (?, ?)', [studentID, active ? 1 : 0]);
      }
      res.json({ success: true });
      const io = req.app.get('io');
io.emit('refresh_data', { message: 'New activity detected' });

   } catch (err) {
      console.error('POST /exempt/flag error', err);
      res.status(500).json({ message: 'Failed to update exempt flag' });
   }
});


/**
  * POST /canteen/student/move-group
  * Body: { studentID, toGroup, town, advanceAmount, date, isPresent }
  */
router.post('/student/move-group', async (req, res) => {
   const { studentID, toGroup, town, advanceAmount, date, isPresent } = req.body;

   // 1. Better Collector ID handling
   const collectorID = req.body.collectedBy || req.body.teacherID || req.body.adminID || req.body.userId || 0;

   const topUpAmount = parseFloat(advanceAmount) || 0;
   const today = new Date().toLocaleDateString('en-CA');
   const recordDate = date || today;

   let conn;
   try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      // 2. UPDATE ATTENDANCE
      if (recordDate && typeof isPresent !== 'undefined') {
         const status = isPresent ? 'present' : 'absent';

         // Fixed: Getting class from students table to ensure it exists
         await conn.query(
            `INSERT INTO attendance (studentID, date, status, town, source, class)
              VALUES (?, ?, ?, ?, 'canteen', (SELECT class FROM students WHERE studentID = ? LIMIT 1))
              ON DUPLICATE KEY UPDATE status = VALUES(status)`,
            [studentID, recordDate, status, town, studentID]
         );

         if (!isPresent) {
            await conn.query(
               `DELETE FROM canteen_fees WHERE studentID = ? AND date = ?`,
               [studentID, recordDate]
            );
         }
      }

      // 3. RESET FLAGS (MATCHED TO YOUR SQL DUMP NAMES)
      // Note: Removed 's' from table names to match your dump (e.g. flag instead of flags)
      await conn.query('UPDATE canteen_credit_flag SET active = 0 WHERE studentID = ?', [studentID]);
      await conn.query('UPDATE canteen_exemption SET active = 0 WHERE studentID = ?', [studentID]);

      // 4. GROUP-SPECIFIC LOGIC
      if (toGroup === 'credit') {
         await conn.query('UPDATE canteen_balance SET balance = 0 WHERE studentID = ?', [studentID]);
         await conn.query('INSERT INTO canteen_credit_flag (studentID, active) VALUES (?, 1) ON DUPLICATE KEY UPDATE active = 1', [studentID]);

      } else if (toGroup === 'exempted') {
         await conn.query('UPDATE canteen_balance SET balance = 0 WHERE studentID = ?', [studentID]);
         await conn.query('INSERT INTO canteen_exemption (studentID, active) VALUES (?, 1) ON DUPLICATE KEY UPDATE active = 1', [studentID]);

      } else if (toGroup === 'advanced') {
         // Update balance (using table name 'canteen_balance' from dump)
         await conn.query(
            `INSERT INTO canteen_balance (studentID, balance)
              VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + ?`,
            [studentID, topUpAmount, topUpAmount]
         );

         // Record Revenue
         if (topUpAmount > 0) {
            await conn.query(
               `INSERT INTO canteen_fees (studentID, amount, date, collectedBy, town, paymentType)
                 VALUES (?, ?, ?, ?, ?, 'advance_topup')
                 ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`,
               [studentID, topUpAmount, recordDate, collectorID, town]
            );
         }

      } else if (toGroup === 'normal') {
         await conn.query('UPDATE canteen_balance SET balance = 0 WHERE studentID = ?', [studentID]);
      }

      await conn.commit();

      // 5. Emit refresh
      const io = req.app.get('io');
      if (io) io.emit('refresh_data', { message: 'Group change detected' });

      res.json({ success: true, message: 'Student moved successfully' });

   } catch (error) {
      if (conn) await conn.rollback();
      console.error("Move Group Error Details:", error); // This helps you see the exact SQL error
      res.status(500).json({ success: false, message: error.sqlMessage || error.message });
   } finally {
      if (conn) conn.release();
   }
});
/**
  * GET /canteen/students/town/:town
  * Returns all students for a specific town (for selection in modals)
  */
router.get('/students/town/:town', async (req, res) => {
   const { town } = req.params;

   try {
      // JOIN with flag tables so the app knows who belongs where
      let query = `
         SELECT
            s.studentID,
            CONCAT(s.Fname, ' ', s.Lname) as name,
            s.class,
            s.town,
            IFNULL(f.active, 0) as is_credit,
            IFNULL(e.active, 0) as is_exempted,
            IFNULL(b.balance, 0) as advance_balance
         FROM students s
         LEFT JOIN canteen_credit_flags f ON s.studentID = f.studentID
         LEFT JOIN canteen_exemptions e ON s.studentID = e.studentID
         LEFT JOIN canteen_balances b ON s.studentID = b.studentID
      `;

      let params = [];
      if (town !== 'all') {
         query += ` WHERE s.town = ?`;
         params.push(town);
      }

      query += ` ORDER BY s.class, s.Fname`;

      const [students] = await db.query(query, params);
      res.json({ success: true, data: students });

   } catch (error) {
      console.error('Error fetching students:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch students' });
   }
});



router.post('/apply-correction', async (req, res) => {
    const { studentID, adjustmentAmount, isPresent, date, collectedBy } = req.body;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Update the 'attendance' table (Matches your dump)
        await connection.query(
            `UPDATE attendance
             SET status = ?, teacherID = ?
             WHERE studentID = ? AND date = ? AND source = 'canteen'`,
            [isPresent ? 'present' : 'absent', collectedBy, studentID, date]
        );

        // 2. Adjust 'canteen_balances' (Matches your dump)
        if (adjustmentAmount !== 0) {
            await connection.query(
                `INSERT INTO canteen_balances (studentID, balance)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE balance = balance + ?`,
                [studentID, adjustmentAmount, adjustmentAmount]
            );

            // 3. Log into 'canteen_fees' as a correction record
            await connection.query(
                `INSERT INTO canteen_fees (studentID, amount, date, collectedBy, town, paymentType)
                 VALUES (?, ?, NOW(), ?, (SELECT town FROM students WHERE studentID = ?), 'correction')`,
                [studentID, adjustmentAmount, collectedBy, studentID]
            );
        }

        await connection.commit();
        res.json({ success: true, message: "Correction applied" });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ success: false, message: err.message });
    } finally {
        connection.release();
    }
});


// Add to your backend routes
router.get('/town-fee/:town', async (req, res) => {
    const { town } = req.params;
    try {
        // Querying the town_fees table from your SQL dump
        const [rows] = await db.query(
            'SELECT daily_fee FROM town_fees WHERE LOWER(town) = LOWER(?)',
            [town]
        );

        if (rows.length > 0) {
            res.json({ success: true, fee: rows[0].daily_fee });
        } else {
            // Default fallback if town is not in the list
            res.json({ success: true, fee: 5.00 });
        }
    } catch (err) {
        console.error("Fee Fetch Error:", err);
        res.status(500).json({ success: false, message: "Database error" });
    }
});
module.exports = router;