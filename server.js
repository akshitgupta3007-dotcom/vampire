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
  // Load login page
  const resp = await client.get("/loginManager/load");
  const $ = cheerio.load(resp.data);

  // Get all session options, pick the latest/current one
  const sessionOptions = [];
  $("select option").each((_, el) => {
    const val = $(el).attr("value") || "";
    if (val && val !== "") sessionOptions.push(val);
  });
  // Latest session = last in the list
  const session = sessionOptions[sessionOptions.length - 1] || "JanJun2025";
  console.log("Sessions available:", sessionOptions);
  console.log("Using session:", session);

  // Submit login
  const body = new URLSearchParams({
    username: username,
    password: password,
    session: session,
  });

  const loginResp = await client.post("/loginManager/login", body.toString(), {
    headers: {
      ...HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": BASE_URL + "/loginManager/load",
      "Origin": BASE_URL,
    },
  });

  return { html: loginResp.data, session };
}

function parseProfile(html) {
  const $ = cheerio.load(html);
  const profile = {};
  // Try common profile fields
  $("td, span, label, div, p, h1, h2, h3, h4, h5, li").each((_, el) => {
    const txt = $(el).text().trim();
    if (/^(Name|Student Name)\s*[:\-]/i.test(txt)) profile.name = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Roll|Roll No|Enrollment|UID|ID)\s*[:\-]/i.test(txt)) profile.uid = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Programme|Course|Program|Branch)\s*[:\-]/i.test(txt)) profile.course = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Semester|Sem)\s*[:\-]/i.test(txt)) profile.semester = txt.replace(/^.*?[:\-]\s*/, "").trim();
    if (/^(Section|Batch)\s*[:\-]/i.test(txt)) profile.section = txt.replace(/^.*?[:\-]\s*/, "").trim();
  });
  // Fallback — grab name from header/welcome message
  if (!profile.name) {
    const welcome = $("[class*=welcome], [class*=student], [id*=name], [id*=Name]").first().text().trim();
    if (welcome) profile.name = welcome.replace(/welcome[,\s]*/i, "").trim();
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
    // Skip header rows
    if (/subject|course|sr\.?\s*no|s\.?no|#/i.test(texts[0])) return;

    let name = "", present = 0, total = 0, percentage = 0;

    // Subject name — first long non-numeric cell
    texts.forEach((t) => {
      if (!name && t.length > 2 && !/^\d+(\.\d+)?%?$/.test(t) && !t.match(/^\d+\/\d+$/)) name = t;
    });
    // Fraction
    texts.forEach((t) => {
      const m = t.match(/(\d+)\s*[\/\-]\s*(\d+)/);
      if (m && !present) { present = parseInt(m[1]); total = parseInt(m[2]); }
    });
    // Percentage
    texts.forEach((t) => {
      const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && !percentage) percentage = parseFloat(m[1]);
    });
    // Also check for plain numbers that might be present/total
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

    // Check login failure
    if (
      low.includes("invalid") ||
      low.includes("incorrect") ||
      low.includes("wrong") ||
      low.includes("failed") ||
      low.includes("loginmanager/load") && low.includes("username")
    ) {
      return res.status(401).json({ error: "Invalid username or password. Please try again." });
    }

    const profile = parseProfile(dashHtml);
    profile.session = session;

    let subjects = [];

    // Try attendance paths for codebrigade
    const attPaths = [
      "/attendanceManager/load",
      "/attendance/load",
      "/studentAttendance/load",
      "/attendanceManager/view",
      "/attendance",
    ];

    for (const p of attPaths) {
      try {
        const r = await client.get(p);
        if (r.data && r.data.length > 500) {
          const parsed = parseAttendance(r.data);
          if (parsed.length > 0) { subjects = parsed; break; }
        }
      } catch (_) {}
    }

    // Try finding attendance link in dashboard
    if (subjects.length === 0) {
      const $ = cheerio.load(dashHtml);
      const attLink = $("a[href*=ttendance], a[href*=Attendance]").first().attr("href");
      if (attLink) {
        try {
          const url = attLink.startsWith("http") ? attLink : BASE_URL + "/" + attLink.replace(/^\//, "");
          const r = await client.get(url);
          subjects = parseAttendance(r.data);
        } catch (_) {}
      }
    }

    return res.json({
      success: true,
      profile,
      subjects,
      message: subjects.length === 0 ? "Logged in successfully! Attendance data could not be fetched automatically — the portal layout may need updating." : null,
    });
  } catch (err) {
    console.error("Vampire error:", err.message);
    return res.status(500).json({ error: "Could not connect to Chitkara portal: " + err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok", name: "Vampire" }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log("Vampire running on port " + PORT));
