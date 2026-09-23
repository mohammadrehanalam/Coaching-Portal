const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const session = require('express-session');
const svgCaptcha = require('svg-captcha');
const { Resend } = require('resend');

const app = express();

// Initialize Resend Email API
const resend = new Resend(process.env.RESEND_API_KEY);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Express Session Setup for CAPTCHA
app.use(session({
    secret: process.env.SESSION_SECRET || 'coaching_portal_secret_key_123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 10 * 60 * 1000 } // 10 Min Session Expiry
}));

// MySQL Connection Pool (Production Safe Connection)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'defaultdb',
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test MySQL Connection & Auto Table Alterations
db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log('MySQL Database Connected Successfully!');
        connection.release();

        // Auto Schema Migrations
        const alterQueries = [
            { table: 'students', column: 'email', query: "ALTER TABLE students ADD COLUMN email VARCHAR(255) UNIQUE AFTER name" },
            { table: 'students', column: 'phone', query: "ALTER TABLE students ADD COLUMN phone VARCHAR(20) AFTER email" },
            { table: 'students', column: 'reset_otp', query: "ALTER TABLE students ADD COLUMN reset_otp VARCHAR(10) AFTER phone" },
            { table: 'test_results', column: 'pdf_url', query: "ALTER TABLE test_results ADD COLUMN pdf_url TEXT AFTER total_marks" },
            { table: 'test_results', column: 'answer_sheet', query: "ALTER TABLE test_results ADD COLUMN answer_sheet LONGTEXT AFTER pdf_url" }
        ];

        alterQueries.forEach(item => {
            db.query(`SHOW COLUMNS FROM ${item.table} LIKE '${item.column}'`, (err, results) => {
                if (!err && results && results.length === 0) {
                    db.query(item.query, (err) => {
                        if (err) console.error(`Error adding ${item.column} column:`, err);
                        else console.log(`Success: '${item.column}' column added to ${item.table} table!`);
                    });
                }
            });
        });
    }
});

// Helper function to send email via Resend
async function sendOtpEmail(toEmail, subject, otpCode) {
    try {
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: [toEmail],
            subject: subject,
            html: `<p>Your OTP for password reset is: <strong>${otpCode}</strong></p><p>This OTP is valid for 10 minutes.</p>`
        });

        if (error) {
            console.error('Resend Delivery Error:', error);
            return { success: false, error: error.message };
        }

        return { success: true, data };
    } catch (err) {
        console.error('Resend Execution Exception:', err);
        return { success: false, error: err.message };
    }
}


// ------------------- PAGE ROUTES -------------------

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});


// ------------------- CAPTCHA ROUTE -------------------

app.get('/api/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 5,
        noise: 2,
        color: true,
        background: '#f8fafc'
    });
    
    req.session.captcha = captcha.text.toLowerCase();
    res.status(200).send({ captcha: captcha.data });
});


// ------------------- STUDENT APIs -------------------

// Student Login
app.post('/api/login', (req, res) => {
    const { rollNumber, roll_number, password, captcha } = req.body;
    const studentRoll = roll_number || rollNumber;

    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.status(400).json({ success: false, message: 'Invalid CAPTCHA! Please try again.' });
    }

    req.session.captcha = null;

    const query = 'SELECT * FROM students WHERE roll_number = ? AND password = ?';
    db.query(query, [studentRoll, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (results && results.length > 0) {
            res.json({ success: true, student: results[0] });
        } else {
            res.json({ success: false, message: 'Invalid Roll Number or Password' });
        }
    });
});

// Student Forgot Password - Send OTP
app.post('/api/student/forgot-password', (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const checkQuery = 'SELECT * FROM students WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.json({ success: false, message: 'Student Email ID not found!' });
        }

        const updateQuery = 'UPDATE students SET reset_otp = ? WHERE email = ?';
        db.query(updateQuery, [otp, email], async (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error saving OTP' });

            try {
                const { error } = await sendOtpEmail(email, 'Student Portal - Password Reset OTP', otp);
                if (error) {
                    return res.json({ success: false, message: 'Failed to send OTP email: ' + error.message });
                }
                res.json({ success: true, message: 'OTP sent to your registered email!' });
            } catch (mailErr) {
                res.json({ success: false, message: 'Failed to send OTP email.' });
            }
        });
    });
});

// Student Reset Password
app.post('/api/student/reset-password', (req, res) => {
    const { email, otp, newPassword } = req.body;

    const query = 'SELECT * FROM students WHERE email = ? AND reset_otp = ?';
    db.query(query, [email, otp], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.json({ success: false, message: 'Invalid or Expired OTP!' });
        }

        const updatePassQuery = 'UPDATE students SET password = ?, reset_otp = NULL WHERE email = ?';
        db.query(updatePassQuery, [newPassword, email], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Failed to update password' });
            res.json({ success: true, message: 'Password reset successfully!' });
        });
    });
});

// Fetch Student Individual Results
app.get('/api/results/:roll', (req, res) => {
    const studentRoll = req.params.roll;
    const query = 'SELECT * FROM test_results WHERE student_roll = ? ORDER BY test_date DESC';
    
    db.query(query, [studentRoll], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        res.json({ success: true, results: results || [] });
    });
});


// ------------------- ADMIN APIs -------------------

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { admin_id, password } = req.body;
    const query = 'SELECT * FROM admins WHERE admin_id = ? AND password = ?';

    db.query(query, [admin_id, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database Error' });
        if (results && results.length > 0) {
            res.json({ success: true, message: 'Login successful' });
        } else {
            res.json({ success: false, message: 'Invalid Admin ID or Password' });
        }
    });
});

// Admin Forgot Password
app.post('/api/admin/forgot-password', (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const checkQuery = 'SELECT * FROM admins WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.json({ success: false, message: 'Admin Email ID not found!' });
        }

        const updateQuery = 'UPDATE admins SET reset_otp = ? WHERE email = ?';
        db.query(updateQuery, [otp, email], async (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error saving OTP' });

            try {
                const { error } = await sendOtpEmail(email, 'Admin Password Reset OTP', otp);
                if (error) {
                    return res.json({ success: false, message: 'Failed to send OTP email: ' + error.message });
                }
                res.json({ success: true, message: 'OTP sent to your email!' });
            } catch (mailErr) {
                res.json({ success: false, message: 'Failed to send OTP email.' });
            }
        });
    });
});

// Admin Reset Password
app.post('/api/admin/reset-password', (req, res) => {
    const { email, otp, newPassword } = req.body;

    const query = 'SELECT * FROM admins WHERE email = ? AND reset_otp = ?';
    db.query(query, [email, otp], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.json({ success: false, message: 'Invalid or Expired OTP!' });
        }

        const updatePassQuery = 'UPDATE admins SET password = ?, reset_otp = NULL WHERE email = ?';
        db.query(updatePassQuery, [newPassword, email], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Failed to update password' });
            res.json({ success: true, message: 'Password reset successfully!' });
        });
    });
});

// --- STUDENT MANAGEMENT (CRUD) ---

// Get All Students
app.get('/api/admin/students', (req, res) => {
    const query = 'SELECT id, roll_number, name, email FROM students ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) {
            console.error("Fetch Students Error:", err);
            return res.status(500).json({ success: false, message: 'Database Error: ' + err.message, students: [] });
        }
        res.json({ success: true, students: results || [] });
    });
});

// Add New Student
app.post('/api/admin/add-student', (req, res) => {
    const { roll_number, name, password, email } = req.body;
    const query = 'INSERT INTO students (roll_number, name, password, email) VALUES (?, ?, ?, ?)';
    
    db.query(query, [roll_number, name, password || '123456', email || null], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Roll number already exists or DB error: ' + err.message });
        res.json({ success: true, message: 'Student added successfully!' });
    });
});

// Update Student Details
app.put('/api/admin/students/:id', (req, res) => {
    const { id } = req.params;
    const { name, roll_number, email } = req.body;
    const query = 'UPDATE students SET name = ?, roll_number = ?, email = ? WHERE id = ?';
    
    db.query(query, [name, roll_number, email || null, id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to update student details.' });
        res.json({ success: true, message: 'Student details updated successfully!' });
    });
});

// Delete Student
app.delete('/api/admin/students/:id', (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM students WHERE id = ?';
    
    db.query(query, [id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to delete student.' });
        res.json({ success: true, message: 'Student deleted successfully!' });
    });
});


// --- TEST RESULT MANAGEMENT (CRUD) ---

// Add Result
app.post('/api/admin/add-result', (req, res) => {
    let { student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url, answer_sheet_json } = req.body;

    if (!test_date || test_date.trim() === '') {
        test_date = new Date().toISOString().split('T')[0];
    }

    const query = `
        INSERT INTO test_results 
        (student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url, answer_sheet) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.query(query, [
        student_roll, 
        test_name, 
        test_date, 
        parseFloat(marks_obtained) || 0, 
        parseFloat(total_marks) || 0, 
        pdf_url || null, 
        answer_sheet_json || null
    ], (err) => {
        if (err) {
            console.error("Database Error on add-result:", err);
            return res.status(500).json({ success: false, message: 'Database Error: ' + (err.sqlMessage || err.message) });
        }
        res.json({ success: true, message: 'Result uploaded successfully!' });
    });
});

// View All Results
app.get('/api/admin/all-results', (req, res) => {
    const query = `
        SELECT tr.id, tr.student_roll, tr.student_roll as roll_number, s.name as student_name, tr.test_name, tr.test_date, tr.marks_obtained, tr.total_marks, tr.pdf_url
        FROM test_results tr
        LEFT JOIN students s ON tr.student_roll = s.roll_number
        ORDER BY tr.test_date DESC
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database Error' });
        res.json({ success: true, results: results || [] });
    });
});

// Update Test Result
app.put('/api/results/:id', (req, res) => {
    const { id } = req.params;
    const { test_name, marks_obtained, total_marks, pdf_url } = req.body;
    const query = 'UPDATE test_results SET test_name = ?, marks_obtained = ?, total_marks = ?, pdf_url = ? WHERE id = ?';

    db.query(query, [test_name, parseFloat(marks_obtained) || 0, parseFloat(total_marks) || 0, pdf_url || null, id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to update result' });
        res.json({ success: true, message: 'Result updated successfully!' });
    });
});

// Delete Test Result
app.delete('/api/results/:id', (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM test_results WHERE id = ?';

    db.query(query, [id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to delete result' });
        res.json({ success: true, message: 'Result deleted successfully!' });
    });
});

// Get Individual Answer Sheet
app.get('/api/admin/answer-sheet/:resultId', (req, res) => {
    const resultId = req.params.resultId;
    const query = `
        SELECT tr.*, s.name as student_name, s.email 
        FROM test_results tr 
        LEFT JOIN students s ON tr.student_roll = s.roll_number 
        WHERE tr.id = ?
    `;

    db.query(query, [resultId], (err, results) => {
        if (err || !results || results.length === 0) return res.status(404).json({ success: false, message: 'Answer sheet not found' });
        res.json({ success: true, details: results[0] });
    });
});

// Testing Helper Route
app.get('/api/test-set-email', (req, res) => {
    const { roll, email } = req.query;
    if (!roll || !email) {
        return res.send("Usage: /api/test-set-email?roll=STU101&email=your_testing_email@gmail.com");
    }

    const query = 'UPDATE students SET email = ? WHERE roll_number = ?';
    db.query(query, [email.trim().toLowerCase(), roll], (err, result) => {
        if (err) return res.send("Error updating email: " + err.message);
        if (result.affectedRows === 0) return res.send("Student Roll Number Not Found!");
        res.send(`Successfully updated Email for Roll Number ${roll} to ${email}`);
    });
});

// Server Port Setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});