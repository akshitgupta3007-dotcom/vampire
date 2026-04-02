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

// ── Chalkpad config (hardcoded so users only need username + password) ──
const CHALKPAD_BASE = "https://punjab.chitkara.edu.in";
const DEFAULT_INSTITUTE = process.env.INSTITUTE || "CIET"; // change if needed
const DEFAULT_SESSION = process.env.SESSION || "2024-25";  // update each year

// ── Build a fresh axios client with cookie jar per request ──
function makeClient() {
  const jar = new CookieJar();
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      baseURL: CHALKPAD_BASE,
      timeout: 30000,
      maxRedirects: 10,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    })
  );
}

// ── Scrape hidden form fields from any HTML page ──
function extractFormFields($, formSelector = "form") {
  const fields = {};
  $(formSelector + " input[type=hidden], input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name");
    const val = $(el).attr("value") || "";
    if (name) fields[name] = val;
  });
  return fields;
}

// ── POST /api/login ──
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const client = makeClient();

  try {
    // Step 1 — Load login page, grab hidden fields + available institute/session options
    const loginPageResp = await client.get("/Interface/index.php");
    const $lp = cheerio.load(loginPageResp.data);
    const hiddenFields = extractFormFields($lp);

    // Figure out which institute value matches our target
    let instituteVal = DEFAULT_INSTITUTE;
    $lp('select[name="Institute"] option, select[name="institute"] option').each((_, el) => {
      const txt = $lp(el).text().trim();
      const val = $lp(el).attr("value") || "";
      // Pick CIET or whatever the env says; fall back to first non-empty option
      if (val && !instituteVal) instituteVal = val;
    });

    // Figure out session value — pick current/latest
    let sessionVal = DEFAULT_SESSION;
    const sessionOptions = [];
    $lp('select[name="Session"] option, select[name="session"] option').each((_, el) => {
      const val = $lp(el).attr("value") || "";
      if (val) sessionOptions.push(val);
    });
    if (sessionOptions.length > 0) {
      // Use the last one (most recent session)
      sessionVal = sessionOptions[sessionOptions.length - 1];
    }

    // Step 2 — Submit login form with hardcoded institute + session
    const formData = new URLSearchParams({
      ...hiddenFields,
      Username: username,
      Password: password,
      Institute: instituteVal,
      Session: sessionVal,
    });

    const loginResp = await client.post("/Interface/index.php", formData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${CHALKPAD_BASE}/Interface/index.php`,
        Origin: CHALKPAD_BASE,
      },
    });

    const $dash = cheerio.load(loginResp.data);

    // Check for login failure
    const bodyText = loginResp.data.toLowerCase();
    if (
      bodyText.includes("invalid") ||
      bodyText.includes("incorrect") ||
      bodyText.includes("wrong") ||
      bodyText.includes("failed") ||
      loginResp.data.includes("index.php") && loginResp.data.includes("Username")
    ) {
      // Still on login page — bad creds
      const errMsg = $dash(".alert, .error, .danger, #lblMsg")
        .first()
        .text()
        .trim();
      return res.status(401).json({
        error: errMsg || "Invalid username or password. Please try again.",
      });
    }

    // Step 3 — Extract profile info from dashboard
    const profile = {};
    profile.name =
      $dash(".student-name, #lblStudentName, [id*='StudentName'], [id*='Name']")
        .first()
        .text()
        .trim() ||
      $dash("h2, h3, h4").first().text().trim() ||
      "Student";

    // Grab whatever info is in the dashboard header
    $dash("td, span, label, p").each((_, el) => {
      const txt = $dash(el).text().trim();
      if (/Roll\s*No|Roll\s*Number/i.test(txt)) {
        const val = txt.replace(/.*?:/, "").trim();
        if (val) profile.rollNo = val;
      }
      if (/Programme|Course|Program/i.test(txt)) {
        const val = txt.replace(/.*?:/, "").trim();
        if (val && val.length < 80) profile.course = val;
      }
      if (/Semester|Sem\b/i.test(txt)) {
        const val = txt.replace(/.*?:/, "").trim();
        if (val && val.length < 20) profile.semester = val;
      }
      if (/Section/i.test(txt)) {
        const val = txt.replace(/.*?:/, "").trim();
        if (val && val.length < 20) profile.section = val;
      }
      if (/Batch/i.test(txt)) {
        const val = txt.replace(/.*?:/, "").trim();
        if (val && val.length < 20) profile.batch = val;
      }
    });
    profile.session = sessionVal;

    // Step 4 — Navigate to attendance page
    // Try to find the attendance link in the dashboard
    let attendanceUrl = null;
    $dash('a[href*="ttendance"], a[href*="Attendance"]').each((_, el) => {
      if (!attendanceUrl) {
        const href = $dash(el).attr("href") || "";
        if (href && !href.startsWith("javascript") && !href.startsWith("#")) {
          attendanceUrl = href.startsWith("http")
            ? href
            : `${CHALKPAD_BASE}/${href.replace(/^\//, "")}`;
        }
      }
    });

    // Common Chalkpad attendance paths
    const attPaths = [
      attendanceUrl,
      `${CHALKPAD_BASE}/Interface/Student/Attendance/StudentAttendance.php`,
      `${CHALKPAD_BASE}/Interface/Student/Attendance.php`,
      `${CHALKPAD_BASE}/Interface/Attendance/StudentAttendance.php`,
      `${CHALKPAD_BASE}/Interface/Student/ViewAttendance.php`,
    ].filter(Boolean);

    let attHtml = null;
    for (const url of attPaths) {
      try {
        const r = await client.get(url);
        if (
          r.data &&
          (r.data.toLowerCase().includes("attendance") ||
            r.data.includes("%") ||
            r.data.match(/\d+\s*\/\s*\d+/))
        ) {
          attHtml = r.data;
          break;
        }
      } catch (_) {}
    }

    // Step 5 — Parse attendance
    let subjects = [];
    if (attHtml) {
      subjects = parseAttendance(attHtml);
    }

    return res.json({
      success: true,
      profile,
      subjects,
      message:
        subjects.length === 0
          ? "Logged in successfully, but no attendance data was found. Chalkpad may have updated its layout."
          : null,
    });
  } catch (err) {
    console.error("Vampire error:", err.message);
    return res.status(500).json({
      error:
        "Could not connect to Chalkpad. The portal may be down or your network may be blocking it.",
      details: err.message,
    });
  }
});

// ── Parse attendance HTML into clean subject array ──
function parseAttendance(html) {
  const $ = cheerio.load(html);
  const subjects = [];
  const seen = new Set();

  // Try rows in any table that looks like an attendance table
  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const texts = [];
    cells.each((_, td) => texts.push($(td).text().trim()));

    // Skip header rows
    if (texts[0].toLowerCase().includes("subject") || texts[0].toLowerCase().includes("sr")) return;

    let name = "", present = 0, total = 0, percentage = 0;

    // Try to find subject name (usually first or second non-numeric cell)
    texts.forEach((t, i) => {
      if (!name && t.length > 3 && !/^\d+$/.test(t) && !t.includes("%")) {
        name = t;
      }
    });

    // Look for fraction (e.g. "18/24")
    texts.forEach((t) => {
      const fracMatch = t.match(/(\d+)\s*[\/\-]\s*(\d+)/);
      if (fracMatch && !present) {
        present = parseInt(fracMatch[1]);
        total = parseInt(fracMatch[2]);
      }
    });

    // Look for percentage
    texts.forEach((t) => {
      const pctMatch = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pctMatch && !percentage) {
        percentage = parseFloat(pctMatch[1]);
      }
    });

    if (!percentage && total > 0) {
      percentage = Math.round((present / total) * 100);
    }

    if (name && total > 0 && !seen.has(name)) {
      seen.add(name);
      subjects.push({
        name: name.replace(/\s+/g, " ").trim(),
        present,
        total,
        percentage,
      });
    }
  });

  return subjects;
}

// Health check
app.get("/api/health", (_, res) =>
  res.json({ status: "ok", name: "Vampire", university: "Chitkara Punjab" })
);

// Serve frontend
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "index.html"));
);

app.listen(PORT, () => {
  console.log(`🧛 Vampire running on http://localhost:${PORT}`);
  console.log(`   Institute: ${DEFAULT_INSTITUTE} | Session: ${DEFAULT_SESSION}`);
});
