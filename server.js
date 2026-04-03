const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3001;
const BASE_URL = "https://cuiet.codebrigade.in";

// Sessions stored in memory keyed by tempToken
const sessions = new Map();

function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    baseURL: BASE_URL,
    timeout: 45000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "okhttp/4.9.2",
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  }));
}

function parseAttendance(html) {
  const $ = cheerio.load(html);
  const subjects = [];
  const seen = new Set();
  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;
    const texts = [];
    cells.each((_, td) => texts.push($(td).text().trim()));
    if (/subject|course|sr\.?\s*no|#/i.test(texts[0])) return;
    let name = "", present = 0, total = 0, percentage = 0;
    texts.forEach(t => { if (!name && t.length > 2 && !/^\d+(\.\d+)?%?$/.test(t) && !t.match(/^\d+\/\d+$/)) name = t; });
    texts.forEach(t => { const m = t.match(/(\d+)\s*[\/]\s*(\d+)/); if (m && !present) { present = parseInt(m[1]); total = parseInt(m[2]); } });
    texts.forEach(t => { const m = t.match(/(\d+(?:\.\d+)?)\s*%/); if (m && !percentage) percentage = parseFloat(m[1]); });
    if (!percentage && total > 0) percentage = Math.round((present / total) * 100);
    if (name && (total > 0 || percentage > 0) && !seen.has(name)) {
      seen.add(name);
      subjects.push({ name: name.replace(/\s+/g, " ").trim(), present, total, percentage });
    }
  });
  return subjects;
}

// POST /api/login — sends credentials, gets OTP sent to email
app.post("/api/login", async (req, res) => {
  const { uid, password } = req.body;
  if (!uid || !password) return res.status(400).json({ error: "Username and password are required." });

  try {
    const client = makeClient();

    // Use the mobile API endpoint (from Attendly source)
    const loginResp = await client.post("/mobile/appLoginAuthV2", {
      username: uid,
      password: password,
      schoolCode: "800002", // Chitkara mobile app code shown on login page
    }, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "okhttp/4.9.2",
      }
    });

    const data = loginResp.data;
    console.log("Login response:", JSON.stringify(data).substring(0, 300));

    // Store client for OTP step
    const tempToken = Math.random().toString(36).substring(2) + Date.now();
    sessions.set(tempToken, { client, uid, loginData: data });
    setTimeout(() => sessions.delete(tempToken), 10 * 60 * 1000);

    // Check if OTP required
    if (data.status === "otp" || data.otp === true || data.requiresOtp ||
        (data.message && data.message.toLowerCase().includes("otp"))) {
      return res.json({ requiresOtp: true, tempToken, message: data.message || "OTP sent to your registered email." });
    }

    // Check login failure
    if (data.status === "error" || data.status === "failed" ||
        (data.message && (data.message.toLowerCase().includes("invalid") || data.message.toLowerCase().includes("incorrect")))) {
      return res.status(401).json({ error: data.message || "Invalid username or password." });
    }

    // Logged in without OTP — fetch attendance
    const result = await fetchAttendance(client, data);
    sessions.delete(tempToken);
    return res.json(result);

  } catch (err) {
    console.error("Login error:", err.message, err.response?.status, JSON.stringify(err.response?.data)?.substring(0, 200));
    return res.status(500).json({ error: "Could not connect to Chitkara portal: " + err.message });
  }
});

// POST /api/verify-otp — verifies OTP and fetches attendance
app.post("/api/verify-otp", async (req, res) => {
  const { tempToken, otp } = req.body;
  if (!tempToken || !otp) return res.status(400).json({ error: "Token and OTP required." });

  const session = sessions.get(tempToken);
  if (!session) return res.status(400).json({ error: "Session expired. Please login again." });

  try {
    const { client, uid } = session;

    const otpResp = await client.post("/mobile/verifyOtp", {
      username: uid,
      otp: otp,
    }, {
      headers: { "Content-Type": "application/json", "User-Agent": "okhttp/4.9.2" }
    });

    const data = otpResp.data;
    console.log("OTP response:", JSON.stringify(data).substring(0, 300));

    if (data.status === "error" || (data.message && data.message.toLowerCase().includes("invalid"))) {
      return res.status(401).json({ error: data.message || "Invalid OTP. Please try again." });
    }

    const result = await fetchAttendance(client, data);
    sessions.delete(tempToken);
    return res.json(result);

  } catch (err) {
    console.error("OTP error:", err.message);
    return res.status(500).json({ error: "OTP verification failed: " + err.message });
  }
});

async function fetchAttendance(client, loginData) {
  // Use mobile attendance endpoint (from Attendly docs)
  let subjects = [];
  let profile = {
    name: loginData.name || loginData.studentName || loginData.fullName || "",
    uid: loginData.userId || loginData.username || loginData.rollNo || "",
    course: loginData.programme || loginData.course || loginData.branch || "",
    semester: loginData.semester || loginData.sem || "",
    section: loginData.section || loginData.batch || "",
  };

  try {
    const attResp = await client.post("/mobile/showAttendance", {
      userId: loginData.userId || loginData.id || "",
      session: loginData.session || "",
    }, {
      headers: { "Content-Type": "application/json", "User-Agent": "okhttp/4.9.2" }
    });

    const attData = attResp.data;
    console.log("Attendance response type:", typeof attData, String(attData).substring(0, 200));

    // Parse if HTML
    if (typeof attData === "string") {
      subjects = parseAttendance(attData);
    } else if (Array.isArray(attData)) {
      // JSON array of subjects
      subjects = attData.map(s => ({
        name: s.subjectName || s.subject || s.name || "",
        present: parseInt(s.present || s.attended || 0),
        total: parseInt(s.total || s.delivered || 0),
        percentage: parseFloat(s.percentage || s.percent || 0),
      })).filter(s => s.name);
    } else if (attData.subjects || attData.attendance) {
      const list = attData.subjects || attData.attendance;
      subjects = list.map(s => ({
        name: s.subjectName || s.subject || s.name || "",
        present: parseInt(s.present || s.attended || 0),
        total: parseInt(s.total || s.delivered || 0),
        percentage: parseFloat(s.percentage || s.percent || 0),
      })).filter(s => s.name);
    }
  } catch (err) {
    console.error("Attendance fetch error:", err.message);
  }

  return {
    success: true,
    profile,
    subjects,
    message: subjects.length === 0 ? "Logged in! Attendance data could not be fetched — try again in a moment." : null,
  };
}

app.get("/api/health", (_, res) => res.json({ status: "ok", name: "Vampire" }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log("Vampire running on port " + PORT));
