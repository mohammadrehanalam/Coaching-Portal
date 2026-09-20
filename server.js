const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const session = require('express-session');
const svgCaptcha = require('svg-captcha');
const { Resend } = require('resend');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Express Session Setup for CAPTCHA
app.use(session({
    secret: 'coaching_portal_secret_key_123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 10 * 60 * 1000 } // 10 Min Session Expiry
}));

// MySQL Connection
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'defaultdb',
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log('MySQL Database Connected Successfully!');
    }
});

// Initialize Resend Email API
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper function to send email via Resend
async function sendOtpEmail(toEmail, subject, otpCode) {
    return await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: toEmail,
        subject: subject,
        html: `<p>Your OTP for password reset is: <strong>${otpCode}</strong></p><p>This OTP is valid for 10 minutes.</p>`
    });
}


// ------------------- PAGE ROUTES -------------------

// Student Login Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Admin Login Page
app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-login.html'));
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

// Student Login with CAPTCHA Verification
app.post('/api/login', (req, res) => {
    const { rollNumber, roll_number, password, captcha } = req.body;
    const studentRoll = roll_number || rollNumber;

    // CAPTCHA Verification Check
    if (!captcha || !req.session.captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.status(400).json({ success: false, message: 'Invalid CAPTCHA! Please try again.' });
    }

    // Reset captcha session after verification attempt
    req.session.captcha = null;

    const query = 'SELECT * FROM students WHERE roll_number = ? AND password = ?';
    db.query(query, [studentRoll, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (results.length > 0) {
            res.json({ success: true, student: results[0] });
        } else {
            res.json({ success: false, message: 'Invalid Roll Number or Password' });
        }
    });
});

// Student Forgot Password - Send OTP via Resend API
app.post('/api/student/forgot-password', (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const checkQuery = 'SELECT * FROM students WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ success: false, message: 'Student Email ID not found!' });
        }

        const updateQuery = 'UPDATE students SET reset_otp = ? WHERE email = ?';
        db.query(updateQuery, [otp, email], async (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error saving OTP' });

            try {
                const { error } = await sendOtpEmail(email, 'Student Portal - Password Reset OTP', otp);
                if (error) {
                    console.error("Resend Error:", error);
                    return res.json({ success: false, message: 'Failed to send OTP email: ' + error.message });
                }
                res.json({ success: true, message: 'OTP sent to your registered email!' });
            } catch (mailErr) {
                console.error("Mail Catch Error:", mailErr);
                res.json({ success: false, message: 'Failed to send OTP email.' });
            }
        });
    });
});

// Student Verify OTP & Reset Password
app.post('/api/student/reset-password', (req, res) => {
    const { email, otp, newPassword } = req.body;

    const query = 'SELECT * FROM students WHERE email = ? AND reset_otp = ?';
    db.query(query, [email, otp], (err, results) => {
        if (err || results.length === 0) {
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
    const query = 'SELECT * FROM test_results WHERE student_roll = ?';
    
    db.query(query, [studentRoll], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        res.json({ success: true, results });
    });
});


// ------------------- ADMIN APIs -------------------

// Admin Login API
app.post('/api/admin/login', (req, res) => {
    const { admin_id, password } = req.body;
    const query = 'SELECT * FROM admins WHERE admin_id = ? AND password = ?';

    db.query(query, [admin_id, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database Error' });
        if (results.length > 0) {
            res.json({ success: true, message: 'Login successful' });
        } else {
            res.json({ success: false, message: 'Invalid Admin ID or Password' });
        }
    });
});

// Admin Forgot Password - Send OTP via Resend API
app.post('/api/admin/forgot-password', (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const checkQuery = 'SELECT * FROM admins WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ success: false, message: 'Admin Email ID not found!' });
        }

        const updateQuery = 'UPDATE admins SET reset_otp = ? WHERE email = ?';
        db.query(updateQuery, [otp, email], async (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error saving OTP' });

            try {
                const { error } = await sendOtpEmail(email, 'Admin Password Reset OTP', otp);
                if (error) {
                    console.error("Resend Error:", error);
                    return res.json({ success: false, message: 'Failed to send OTP email: ' + error.message });
                }
                res.json({ success: true, message: 'OTP sent to your email!' });
            } catch (mailErr) {
                console.error("Mail Catch Error:", mailErr);
                res.json({ success: false, message: 'Failed to send OTP email.' });
            }
        });
    });
});

// Admin Verify OTP & Reset Password
app.post('/api/admin/reset-password', (req, res) => {
    const { email, otp, newPassword } = req.body;

    const query = 'SELECT * FROM admins WHERE email = ? AND reset_otp = ?';
    db.query(query, [email, otp], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ success: false, message: 'Invalid or Expired OTP!' });
        }

        const updatePassQuery = 'UPDATE admins SET password = ?, reset_otp = NULL WHERE email = ?';
        db.query(updatePassQuery, [newPassword, email], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Failed to update password' });
            res.json({ success: true, message: 'Password reset successfully!' });
        });
    });
});

// Add New Student
app.post('/api/admin/add-student', (req, res) => {
    const { roll_number, name, password, email } = req.body;
    const query = 'INSERT INTO students (roll_number, name, password, email) VALUES (?, ?, ?, ?)';
    
    db.query(query, [roll_number, name, password, email || null], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Roll number already exists or DB error' });
        res.json({ success: true, message: 'Student added successfully!' });
    });
});

// Upload Test Result & Answer Sheet URL
app.post('/api/admin/add-result', (req, res) => {
    const { student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url, answer_sheet_json } = req.body;
    const query = 'INSERT INTO test_results (student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url, answer_sheet) VALUES (?, ?, ?, ?, ?, ?, ?)';
    
    db.query(query, [student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url || null, answer_sheet_json || null], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        res.json({ success: true, message: 'Result uploaded successfully!' });
    });
});

// Admin API: View All Student Scores
app.get('/api/admin/all-results', (req, res) => {
    const query = `
        SELECT tr.id, tr.student_roll, s.name as student_name, tr.test_name, tr.test_date, tr.marks_obtained, tr.total_marks, tr.pdf_url
        FROM test_results tr
        LEFT JOIN students s ON tr.student_roll = s.roll_number
        ORDER BY tr.test_date DESC
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database Error' });
        res.json({ success: true, results });
    });
});

// Admin API: Get Individual Student Detailed Answer Sheet
app.get('/api/admin/answer-sheet/:resultId', (req, res) => {
    const resultId = req.params.resultId;
    const query = `
        SELECT tr.*, s.name as student_name, s.email 
        FROM test_results tr 
        LEFT JOIN students s ON tr.student_roll = s.roll_number 
        WHERE tr.id = ?
    `;

    db.query(query, [resultId], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ success: false, message: 'Answer sheet not found' });
        res.json({ success: true, details: results[0] });
    });
});


// Server Port Setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});