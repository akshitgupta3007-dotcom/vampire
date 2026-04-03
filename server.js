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

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Origin": BASE_URL,
  "Referer": BASE_URL + "/loginManager/load",
};

// Store sessions temporarily in memory (keyed by a temp token)
const pendingSessions = new Map();

function makeClient() {
  const jar = new CookieJar();
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      baseURL: BASE_URL,
      timeout: 45000,
      maxRedirects: 10,
      headers: HEADERS,
    })
  );
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
    if (/subject|course|sr\.?\s*no|s\.?no|#/i.test(texts[0])) return;

    let name = "", present = 0, total = 0, percentage = 0;
    texts.forEach((t) => {
      if (!name && t.length > 2 && !/^\d+(\.\d+)?%?$/.test(t) && !t.match(/^\d+\/\d+$/)) name = t;
    });
    texts.forEach((t) => {
      const m = t.match(/(\d+)\s*[\/\-]\s*(\d+)/);
      if (m && !present) { present = parseInt(m[1]); total = parseInt(m[2]); }
    });
    texts.forEach((t) => {
      const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && !percentage) percentage = parseFloat(m[1]);
    });
    if (!present || !total) {
      const nums = texts.filter(t => /^\d+$/.test(t)).map(Number);
      if (nums.length >= 2) { present = nums[nums.length - 2]; total = nums[nums.length - 1]; }
    }
    if (!percentage && total > 0) percentage = Math.round((present / total) * 100);
    if (name && (total > 0 || percentage > 0) && !seen.has(name)) {
      seen.add(name);
      subjects.push({ name: name.replace(/\s+/g, " ").trim(), present, total, percentage });
    }
  });
  return subjects;
}

function parseProfile(html) {
  const $ = cheerio.load(html);
  const profile = {};
  $("td, span, label, div, p, h1, h2, h3, h4, h5, li").each((_, el) => {
    const txt = $(el).text().trim();
    if (/^(Name|Student Name)\s*[:\-]/i.test(txt)) profile.name = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Roll|Roll No|Enrollment|UID|ID)\s*[:\-]/i.test(txt)) profile.uid = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Programme|Course|Program|Branch)\s*[:\-]/i.test(txt)) profile.course = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Semester|Sem)\s*[:\-]/i.test(txt)) profile.semester = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Section|Batch)\s*[:\-]/i.test(txt)) profile.section = txt.replace(/^.*?[:\-]\s*/, "").trim();
  });
  return profile;
}

// Step 1: Login — triggers OTP
app.post("/api/login", async (req, res) => {
  const { uid, password } = req.body;
  if (!uid || !password) return res.status(400).json({ error: "Username and password are required." });

  try {
    const client = makeClient();

    // Load login page to get session cookies
    await client.get("/loginManager/load");

    // Get available sessions
    const loginPage = await client.get("/loginManager/load");
    const $ = cheerio.load(loginPage.data);
    const sessions = [];
    $("select[name=session] option, select option").each((_, el) => {
      const val = $(el).attr("value") || "";
      if (val && val.trim() !== "" && val !== "---Select---") sessions.push(val);
    });
    const session = sessions[sessions.length - 1] || "JanJun2026";
    console.log("Session:", session);

    // Submit login
    const loginBody = new URLSearchParams({ username: uid, password, session });
    const loginResp = await client.post("/loginManager/login", loginBody.toString(), {
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    });

    const respData = loginResp.data;
    console.log("Login response:", JSON.stringify(respData).substring(0, 200));

    // Check if it returned JSON with OTP requirement
    if (typeof respData === "object") {
      if (respData.status === "otp" || respData.otp || respData.message?.toLowerCase().includes("otp")) {
        // Store client for OTP verification
        const tempToken = Math.random().toString(36).substring(2);
        pendingSessions.set(tempToken, { client, uid, session });
        setTimeout(() => pendingSessions.delete(tempToken), 5 * 60 * 1000); // expire in 5 min
        return res.json({ requiresOtp: true, tempToken, message: "OTP sent to your registered email." });
      }
      if (respData.status === "success" || respData.token || respData.userId) {
        // Logged in without OTP
        const token = Math.random().toString(36).substring(2);
        pendingSessions.set(token, { client, uid, session, loggedIn: true });
        return res.json({ requiresOtp: false, tempToken: token });
      }
      if (respData.status === "error" || respData.message?.toLowerCase().includes("invalid")) {
        return res.status(401).json({ error: respData.message || "Invalid credentials." });
      }
    }

    // HTML response — check if 2FA page
    const html = typeof respData === "string" ? respData : JSON.stringify(respData);
    if (html.toLowerCase().includes("otp") || html.toLowerCase().includes("two-factor") || html.includes("verifyOtp")) {
      const tempToken = Math.random().toString(36).substring(2);
      pendingSessions.set(tempToken, { client, uid, session });
      setTimeout(() => pendingSessions.delete(tempToken), 5 * 60 * 1000);
      return res.json({ requiresOtp: true, tempToken, message: "OTP sent to your registered email." });
    }

    // Might be logged in — try fetching attendance
    const tempToken = Math.random().toString(36).substring(2);
    pendingSessions.set(tempToken, { client, uid, session, loggedIn: true, dashHtml: html });
    return res.json({ requiresOtp: false, tempToken });

  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Could not connect to portal: " + err.message });
  }
});

// Step 2: Verify OTP
app.post("/api/verify-otp", async (req, res) => {
  const { tempToken, otp } = req.body;
  if (!tempToken || !otp) return res.status(400).json({ error: "Token and OTP are required." });

  const session = pendingSessions.get(tempToken);
  if (!session) return res.status(400).json({ error: "Session expired. Please login again." });

  try {
    const { client } = session;

    // Submit OTP
    const otpBody = new URLSearchParams({ otp });
    const otpResp = await client.post("/multiAuthentication/verifyOtp", otpBody.toString(), {
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    });

    const respData = otpResp.data;
    console.log("OTP response:", JSON.stringify(respData).substring(0, 200));

    const html = typeof respData === "string" ? respData : JSON.stringify(respData);
    if (html.toLowerCase().includes("invalid") || html.toLowerCase().includes("wrong") || html.toLowerCase().includes("incorrect")) {
      return res.status(401).json({ error: "Invalid OTP. Please try again." });
    }

    // OTP verified — fetch attendance
    return await fetchAndReturnData(client, session, res);

  } catch (err) {
    console.error("OTP error:", err.message);
    return res.status(500).json({ error: "OTP verification failed: " + err.message });
  }
});

// Step 3: Fetch attendance data after login
app.post("/api/attendance", async (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken) return res.status(400).json({ error: "Token required." });

  const session = pendingSessions.get(tempToken);
  if (!session) return res.status(400).json({ error: "Session expired. Please login again." });

  return await fetchAndReturnData(session.client, session, res);
});

async function fetchAndReturnData(client, session, res) {
  try {
    let subjects = [];
    let profile = {};

    const attPaths = [
      "/attendanceManager/load",
      "/attendance/load",
      "/studentAttendance/load",
      "/attendanceManager/view",
      "/Home/Attendance",
    ];

    for (const p of attPaths) {
      try {
        const r = await client.get(p);
        if (r.data && r.data.length > 200) {
          const parsed = parseAttendance(r.data);
          if (parsed.length > 0) {
            subjects = parsed;
            profile = parseProfile(r.data);
            break;
          }
        }
      } catch (_) {}
    }

    // Try dashboard for profile
    if (!profile.name) {
      try {
        const dash = await client.get("/dashboard/load");
        profile = parseProfile(dash.data);
      } catch (_) {}
    }

    pendingSessions.delete(session.tempToken);

    return res.json({
      success: true,
      profile: { name: profile.name || session.uid, ...profile, session: session.session },
      subjects,
      message: subjects.length === 0 ? "Logged in! Attendance data could not be fetched automatically." : null,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch attendance: " + err.message });
  }
}

app.get("/api/health", (_, res) => res.json({ status: "ok", name: "Vampire" }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log("Vampire running on port " + PORT));
