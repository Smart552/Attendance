const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(cors());

// Serve static files from the current directory so that login.html, signup.html, etc. can be served.
app.use(express.static(__dirname));

// Middleware to trim whitespace/newline characters from req.url
app.use((req, res, next) => {
  if (req.url) {
    req.url = req.url.trim();
  }
  next();
});

// Serve index.html when the root URL is accessed
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Connect to MongoDB Atlas using connection string from environment variable
const mongoURI = process.env.MONGO_URI || 'mongodb+srv://smartattendance302:smartattendance%402025@cluster1.s8aq1.mongodb.net/?retryWrites=true&w=majority&appName=Cluster1';
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB Atlas"))
  .catch(err => console.error("MongoDB connection error:", err));

/* =====================
   Schema Definitions
===================== */

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true }, // For students: roll no; for teachers: a unique identifier (name)
  name: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['teacher', 'student'], default: 'student' },
  fingerprintId: { type: String, required: true },
  subject: { type: String },  // Teacher’s subject
  attendance: { type: String, default: 'absent' },
  lastUpdated: { type: Date },
  attendanceSessionOpen: { type: Boolean, default: false },
  sessionStart: { type: Date },
  activeSessionId: { type: mongoose.Schema.Types.ObjectId } // To store current session id
});
const User = mongoose.model('User', userSchema);

// Session Schema – records a teacher’s complete session (from start to end)
const sessionSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionStart: { type: Date, required: true },
  sessionEnd: { type: Date, required: true }
});
const Session = mongoose.model('Session', sessionSchema);

// Attendance Record Schema – logs each student’s attendance for a session
const attendanceRecordSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  attended: { type: Boolean, required: true }
});
const AttendanceRecord = mongoose.model('AttendanceRecord', attendanceRecordSchema);

/* =====================
   Global Variables
===================== */

// Global counter for unique fingerprint IDs (if needed for enrollment)
let nextFingerprintId = 1;

/* =====================
   Endpoints
===================== */

// Signup endpoint
app.post('/signup', async (req, res) => {
  const { username, name, password, role, fingerprintId, subject } = req.body;
  
  if (role === "student") {
    if (!username || !name || !password || !fingerprintId) {
      return res.status(400).json({ message: "Missing required fields for student." });
    }
  } else if (role === "teacher") {
    if (!username || !name || !password || !fingerprintId || !subject) {
      return res.status(400).json({ message: "Missing required fields for teacher." });
    }
  }
  
  try {
    const newUser = new User({ username, name, password, role, fingerprintId, subject });
    await newUser.save();
    res.status(201).json({ message: "User created successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password, role } = req.body;
  try {
    const user = await User.findOne({ username, password, role });
    if (user) {
      res.json({ message: "Login successful", user });
    } else {
      res.status(401).json({ message: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Scan endpoint – handles attendance updates
app.post('/scan', async (req, res) => {
  const { fingerprintId } = req.body;
  if (!fingerprintId) {
    return res.status(400).json({ message: "Missing fingerprintId" });
  }
  
  try {
    const user = await User.findOne({ fingerprintId });
    if (!user) {
      return res.status(404).json({ message: "No match found" });
    }
    
    if (user.role === "teacher") {
      // Check if any teacher's session is active.
      const activeTeacher = await User.findOne({ role: "teacher", attendanceSessionOpen: true });
      
      // If a session is active and it does not belong to this teacher, reject the scan.
      if (activeTeacher && activeTeacher._id.toString() !== user._id.toString()) {
        return res.status(403).json({ message: "Another teacher's session is active. You cannot start or end a session." });
      }
      
      // If no session is active for this teacher, then start one.
      if (!user.attendanceSessionOpen) {
        // Reset all student attendance to "absent" at the start of a new session.
        await User.updateMany({ role: "student" }, { attendance: "absent" });
        user.attendanceSessionOpen = true;
        user.sessionStart = new Date();
        user.activeSessionId = new mongoose.Types.ObjectId();
        await user.save();
        return res.json({ message: Attendance session started. Subject: ${user.subject}, subject: user.subject });
      } else {
        // End session: record session data.
        const sessionStart = user.sessionStart;
        const sessionEnd = new Date();
        const session = new Session({
          teacherId: user._id,
          sessionStart,
          sessionEnd
        });
        await session.save();
        user.attendanceSessionOpen = false;
        user.sessionStart = null;
        user.activeSessionId = null;
        await user.save();
        return res.json({ message: "Attendance session ended." });
      }
      
    } else if (user.role === "student") {
      // Student scan: record attendance only if a teacher's session is active.
      const activeTeacher = await User.findOne({ role: "teacher", attendanceSessionOpen: true });
      if (activeTeacher && activeTeacher.activeSessionId) {
        user.attendance = "present";
        user.lastUpdated = new Date();
        const updatedUser = await user.save();
        console.log("Updated student record:", updatedUser);
        const attendanceRecord = new AttendanceRecord({
          studentId: user._id,
          sessionId: activeTeacher.activeSessionId,
          attended: true
        });
        const savedRecord = await attendanceRecord.save();
        console.log("Saved attendance record:", savedRecord);
        return res.json({ message: Attendance updated for student. Roll No: ${user.username}, user });
      } else {
        return res.status(403).json({ message: "Attendance session not open. Please wait for a teacher to start a session." });
      }
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Endpoint: Get teacher sessions count (i.e., total complete sessions)
app.get('/teacher-sessions/:teacherId', async (req, res) => {
  const { teacherId } = req.params;
  const period = req.query.period || "daily";
  const now = new Date();
  let threshold;
  if (period === "daily") {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "weekly") {
    threshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "monthly") {
    threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  
  try {
    const count = await Session.countDocuments({
      teacherId,
      sessionEnd: { $gte: threshold }
    });
    res.json({ totalLectures: count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Endpoint: Get student attendance data for teacher view (all students for a subject)
app.get('/student-attendance', async (req, res) => {
  const { subject, period } = req.query;
  const now = new Date();
  let threshold;
  if (period === "daily") {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "weekly") {
    threshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "monthly") {
    threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  
  try {
    const students = await User.find({
      role: "student",
      $or: [
        { lastUpdated: { $gte: threshold } },
        { lastUpdated: { $exists: false } }
      ]
    });
    res.json(students);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Endpoint: Get student attendance data for individual student view
app.get('/student-attendance/:studentId', async (req, res) => {
  const { studentId } = req.params;
  const period = req.query.period || "daily";
  const now = new Date();
  let threshold;
  if (period === "daily") {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "weekly") {
    threshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "monthly") {
    threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    threshold = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  
  try {
    const totalLectures = await Session.countDocuments({
      sessionEnd: { $gte: threshold }
    });
    const attendedLectures = await AttendanceRecord.countDocuments({
      studentId,
      attended: true
    });
    res.json({ totalLectures, attendedLectures });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Enrollment endpoint – simulates fingerprint enrollment by assigning a unique ID.
app.post('/enroll', async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const id = nextFingerprintId;
  nextFingerprintId++;
  console.log("Enrolled fingerprint with id:", id);
  res.status(200).json({ success: true, fingerprintId: id });
});

// PDF Download endpoint for teacher (updated to include student data)
app.get('/download-pdf/:teacherId', async (req, res) => {
  try {
    const teacherId = req.params.teacherId;
    const period = req.query.period || "daily";
    const teacher = await User.findById(teacherId);
    if (!teacher || teacher.role !== "teacher") {
      return res.status(404).json({ message: "Teacher not found." });
    }
    
    // Query all students (optionally, you could filter by subject or session)
    const students = await User.find({ role: "student" }).sort({ username: 1 });
    
    const doc = new PDFDocument();
    const filename = encodeURIComponent(teacher.name + "_attendance.pdf");
    res.setHeader('Content-disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);
    
    // Header section
    doc.fontSize(25).text("Attendance Report", { align: 'center' });
    doc.moveDown();
    doc.fontSize(18).text("Teacher: " + teacher.name, { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text("Subject: " + teacher.subject, { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text(Period: ${period.charAt(0).toUpperCase() + period.slice(1)}, { align: 'center' });
    doc.moveDown();
    
    // Student data section
    doc.fontSize(20).text("Student Attendance:", { underline: true });
    doc.moveDown(0.5);
    students.forEach((student) => {
      doc.fontSize(14).text(Name: ${student.name} | Roll No: ${student.username} | Status: ${student.attendance});
    });
    
    doc.end();
    
    // After sending the PDF, reset attendance for all students marked "present".
    User.updateMany({ role: "student", attendance: "present" }, { attendance: "absent" })
      .then(() => console.log("Student attendance reset to absent after download"))
      .catch(err => console.error("Error resetting student attendance:", err));
      
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PDF Download endpoint for student
app.get('/download-pdf/student/:studentId', async (req, res) => {
  try {
    const studentId = req.params.studentId;
    const period = req.query.period || "daily";
    const student = await User.findById(studentId);
    if (!student || student.role !== "student") {
      return res.status(404).json({ message: "Student not found." });
    }
    const doc = new PDFDocument();
    const filename = encodeURIComponent(student.name + "_attendance.pdf");
    res.setHeader('Content-disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(25).text("Attendance Report", { align: 'center' });
    doc.moveDown();
    doc.fontSize(18).text("Student: " + student.name, { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text(Period: ${period.charAt(0).toUpperCase() + period.slice(1)}, { align: 'center' });
    doc.end();
    
    // Reset the individual student's attendance after download.
    student.attendance = "absent";
    student.lastUpdated = new Date();
    student.save().then(() => console.log("Student attendance reset to absent after download"))
      .catch(err => console.error("Error resetting student attendance:", err));
      
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Optional endpoint: Get all users (for teacher dashboard table)
app.get('/users', async (req, res) => {
  try {
    const users = await User.find({});
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// NEW endpoint: Return teacher subject based on fingerprintId.
app.get('/get-teacher-subject', async (req, res) => {
  let { fingerprintId } = req.query;
  fingerprintId = fingerprintId.toString(); // Ensure string type
  const teacher = await User.findOne({ fingerprintId, role: "teacher" });
  if (!teacher) {
    return res.status(404).json({ message: "Teacher not found" });
  }
  res.json({ subject: teacher.subject });
});

// NEW endpoint: Return student details based on fingerprintId.
app.get('/get-student-details', async (req, res) => {
  let { fingerprintId } = req.query;
  fingerprintId = fingerprintId.toString(); // Ensure string type
  const student = await User.findOne({ fingerprintId, role: "student" });
  if (!student) {
    return res.status(404).json({ message: "Student not found" });
  }
  res.json({ username: student.username });
});

// NEW endpoint: Return user details based on fingerprintId.
app.get('/get-user', async (req, res) => {
  let { fingerprintId } = req.query;
  fingerprintId = fingerprintId.toString(); // Ensure string type
  try {
    const user = await User.findOne({ fingerprintId });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ role: user.role, username: user.username });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// NEW endpoint: Update teacher session state based on fingerprintId.
app.get('/update-session', async (req, res) => {
  let { fingerprintId, active } = req.query;
  fingerprintId = fingerprintId.toString(); // Ensure string type
  try {
    const teacher = await User.findOne({ fingerprintId, role: "teacher" });
    if (!teacher) {
      return res.status(404).json({ message: "Teacher not found" });
    }
    teacher.attendanceSessionOpen = (active === "1");
    if (teacher.attendanceSessionOpen) {
      teacher.sessionStart = new Date();
      teacher.activeSessionId = new mongoose.Types.ObjectId();
    } else {
      teacher.sessionStart = null;
      teacher.activeSessionId = null;
    }
    await teacher.save();
    res.json({ message: "Session updated", active: teacher.attendanceSessionOpen });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// NEW endpoint: Update student attendance based on fingerprintId.
app.get('/update-attendance', async (req, res) => {
  let { fingerprintId } = req.query;
  fingerprintId = fingerprintId.toString(); // Ensure string type
  try {
    const student = await User.findOne({ fingerprintId, role: "student" });
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }
    student.attendance = "present";
    student.lastUpdated = new Date();
    await student.save();
    res.json({ message: "Attendance updated", username: student.username });
  } catch(err) {
    res.status(500).json({ message: err.message });
  }
});

// Listen on all interfaces
app.listen(port, '0.0.0.0', () => {
  console.log(Server running on port ${port} and listening on all interfaces);
});
