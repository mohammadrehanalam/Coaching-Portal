const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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

// Nodemailer Transport Setup for OTP Email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'mohammadrehanalam71@gmail.com',
        pass: process.env.EMAIL_PASS || 'jrwinebdjsmnnxxc'
    }
});

// DEFAULT HOME ROUTE (Student Login)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// ADMIN LOGIN ROUTE
app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-login.html'));
});

// ------------------- STUDENT APIs -------------------

// Student Login
app.post('/api/login', (req, res) => {
    const { roll_number, password } = req.body;
    const query = 'SELECT * FROM students WHERE roll_number = ? AND password = ?';
    
    db.query(query, [roll_number, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (results.length > 0) {
            res.json({ success: true, student: results[0] });
        } else {
            res.json({ success: false, message: 'Invalid Roll Number or Password' });
        }
    });
});

// Fetch Student Results
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

// Forgot Password - Send OTP
app.post('/api/admin/forgot-password', (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 Digit OTP

    const checkQuery = 'SELECT * FROM admins WHERE email = ?';
    db.query(checkQuery, [email], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ success: false, message: 'Email ID not found!' });
        }

        // Save OTP to DB
        const updateQuery = 'UPDATE admins SET reset_otp = ? WHERE email = ?';
        db.query(updateQuery, [otp, email], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error saving OTP' });

            // Send Email via Nodemailer
            const mailOptions = {
                from: 'YOUR_GMAIL_ID@gmail.com', // Apna Gmail ID yahan bhi dalein
                to: email,
                subject: 'Admin Password Reset OTP',
                text: `Your OTP for resetting the Admin Password is: ${otp}\nThis OTP is valid for 10 minutes.`
            };

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) {
                    console.error("Mail Error:", mailErr);
                    return res.json({ success: false, message: 'Failed to send OTP email. Check Gmail config.' });
                }
                res.json({ success: true, message: 'OTP sent to your email!' });
            });
        });
    });
});

// Verify OTP & Reset Password
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
    const { roll_number, name, password } = req.body;
    const query = 'INSERT INTO students (roll_number, name, password) VALUES (?, ?, ?)';
    
    db.query(query, [roll_number, name, password], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Roll number already exists or DB error' });
        res.json({ success: true, message: 'Student added successfully!' });
    });
});

// Upload Test Result & Copy Link
app.post('/api/admin/add-result', (req, res) => {
    const { student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url } = req.body;
    const query = 'INSERT INTO test_results (student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url) VALUES (?, ?, ?, ?, ?, ?)';
    
    db.query(query, [student_roll, test_name, test_date, marks_obtained, total_marks, pdf_url], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        res.json({ success: true, message: 'Result uploaded successfully!' });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});