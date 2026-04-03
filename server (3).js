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
const BASE_URL = "https://punjab.chitkara.edu.in";
const INSTITUTE = "CUIET"; // Chitkara University Institute of Engineering & Technology

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

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

async function doLogin(client, username, password) {
  const resp = await client.get("/Interface/");
  const $ = cheerio.load(resp.data);

  // Get latest session from dropdown
  const sessions = [];
  $("select option").each((_, el) => {
    const val = $(el).attr("value") || "";
    if (val && val.match(/\d{4}-\d{2}/)) sessions.push(val);
  });
  const session = sessions[sessions.length - 1] || "2024-25";
  console.log("Using session:", session, "institute:", INSTITUTE);

  const body = new URLSearchParams({
    username,
    password,
    Institute: INSTITUTE,
    Session: session,
  });

  const loginResp = await client.post("/Interface/index.php", body.toString(), {
    headers: {
      ...HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": BASE_URL + "/Interface/",
      "Origin": BASE_URL,
    },
  });

  return { html: loginResp.data, session };
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
  if (!profile.name) {
    profile.name = $("[class*=welcome], [class*=student-name], [id*=StudentName]").first().text().trim()
      .replace(/welcome[,\s]*/i, "").trim() || "";
  }
  return profile;
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

app.post("/api/login", async (req, res) => {
  const { uid, password } = req.body;
  if (!uid || !password) return res.status(400).json({ error: "Username and password are required." });

  try {
    const client = makeClient();
    const { html: dashHtml, session } = await doLogin(client, uid, password);
    const low = dashHtml.toLowerCase();

    if (low.includes("invalid") || low.includes("incorrect") || low.includes("wrong") ||
      (low.includes("username") && low.includes("password") && !low.includes("logout"))) {
      return res.status(401).json({ error: "Invalid username or password. Please try again." });
    }

    const profile = parseProfile(dashHtml);
    profile.session = session;

    let subjects = [];
    const attPaths = [
      "/Interface/Attendance/StudentAttendance.php",
      "/Interface/Student/Attendance.php",
      "/Interface/Attendance.php",
      "/Interface/Student/ViewAttendance.php",
      "/Interface/Attendance/ViewAttendance.php",
    ];

    for (const p of attPaths) {
      try {
        const r = await client.get(p);
        if (r.data && r.data.length > 200) {
          const parsed = parseAttendance(r.data);
          if (parsed.length > 0) { subjects = parsed; break; }
        }
      } catch (_) {}
    }

    if (subjects.length === 0) {
      const $ = cheerio.load(dashHtml);
      const attLink = $("a[href*=ttendance], a[href*=Attendance]").first().attr("href");
      if (attLink) {
        try {
          const url = attLink.startsWith("http") ? attLink : BASE_URL + "/" + attLink.replace(/^\//, "");
          subjects = parseAttendance((await client.get(url)).data);
        } catch (_) {}
      }
    }

    return res.json({
      success: true,
      profile,
      subjects,
      message: subjects.length === 0 ? "Logged in! Attendance could not be fetched automatically — try again." : null,
    });
  } catch (err) {
    console.error("Vampire error:", err.message);
    return res.status(500).json({ error: "Could not connect to Chalkpad: " + err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok", name: "Vampire" }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log("Vampire running on port " + PORT));
