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
const BASE_URL = "https://uims.cuchd.in";

function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, baseURL: BASE_URL, timeout: 30000, maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
    },
  }));
}

async function doLogin(client, uid, password) {
  const resp = await client.get("/uims/");
  const $ = cheerio.load(resp.data);
  const tokens = {};
  $("input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name");
    if (name) tokens[name] = $(el).attr("value") || "";
  });

  if ($("[id*=Password]").length > 0) {
    const body = new URLSearchParams({ ...tokens, txtUserId: uid, txtLoginPassword: password, __EVENTTARGET: "", __EVENTARGUMENT: "", btnLogin: "Login" });
    return (await client.post("/uims/", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } })).data;
  } else {
    const body1 = new URLSearchParams({ ...tokens, txtUserId: uid, __EVENTTARGET: "", __EVENTARGUMENT: "", btnNext: "Next" });
    const resp1 = await client.post("/uims/", body1.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const $2 = cheerio.load(resp1.data);
    const tokens2 = {};
    $2("input[type=hidden]").each((_, el) => { const n = $2(el).attr("name"); if (n) tokens2[n] = $2(el).attr("value") || ""; });
    const body2 = new URLSearchParams({ ...tokens2, txtLoginPassword: password, __EVENTTARGET: "", __EVENTARGUMENT: "", btnLogin: "Login" });
    return (await client.post("/uims/", body2.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } })).data;
  }
}

function parseProfile(html) {
  const $ = cheerio.load(html);
  const profile = {};
  $("td, span, label, div, p").each((_, el) => {
    const txt = $(el).text().trim();
    if (/^(Name|Student Name)\s*:/i.test(txt)) profile.name = txt.replace(/^.*?:\s*/, "").trim();
    if (/^(UID|User ID|Roll)\s*:/i.test(txt)) profile.uid = txt.replace(/^.*?:\s*/, "").trim();
    if (/^(Programme|Course|Program)\s*:/i.test(txt)) profile.course = txt.replace(/^.*?:\s*/, "").trim();
    if (/^(Semester|Sem)\s*:/i.test(txt)) profile.semester = txt.replace(/^.*?:\s*/, "").trim();
    if (/^Section\s*:/i.test(txt)) profile.section = txt.replace(/^.*?:\s*/, "").trim();
  });
  if (!profile.name) profile.name = $(".student-name, #lblStudentName").first().text().trim() || "";
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
    if (/subject|sr\.?\s*no/i.test(texts[0])) return;
    let name = "", present = 0, total = 0, percentage = 0;
    texts.forEach((t) => { if (!name && t.length > 3 && !/^\d+$/.test(t) && !t.includes("%")) name = t; });
    texts.forEach((t) => { const m = t.match(/(\d+)\s*[\/\-]\s*(\d+)/); if (m && !present) { present = parseInt(m[1]); total = parseInt(m[2]); } });
    texts.forEach((t) => { const m = t.match(/(\d+(?:\.\d+)?)\s*%/); if (m && !percentage) percentage = parseFloat(m[1]); });
    if (!percentage && total > 0) percentage = Math.round((present / total) * 100);
    if (name && total > 0 && !seen.has(name)) { seen.add(name); subjects.push({ name: name.replace(/\s+/g, " ").trim(), present, total, percentage }); }
  });
  return subjects;
}

app.post("/api/login", async (req, res) => {
  const { uid, password } = req.body;
  if (!uid || !password) return res.status(400).json({ error: "UID and password are required." });
  try {
    const client = makeClient();
    const dashHtml = await doLogin(client, uid, password);
    const low = dashHtml.toLowerCase();
    if (low.includes("invalid") || low.includes("incorrect") || low.includes("wrong password")) {
      return res.status(401).json({ error: "Invalid credentials. Please check your UID and password." });
    }
    const profile = parseProfile(dashHtml);
    let subjects = [];
    for (const p of ["/uims/Attendance/StudentAttendance.aspx", "/uims/Student/Attendance.aspx", "/uims/Attendance.aspx"]) {
      try {
        const r = await client.get(p);
        if (r.data && (r.data.includes("%") || r.data.match(/\d+\s*\/\s*\d+/))) {
          subjects = parseAttendance(r.data);
          if (subjects.length > 0) break;
        }
      } catch (_) {}
    }
    if (subjects.length === 0) {
      const $ = cheerio.load(dashHtml);
      const attLink = $("a[href*=ttendance]").first().attr("href");
      if (attLink) {
        try {
          const url = attLink.startsWith("http") ? attLink : BASE_URL + "/" + attLink.replace(/^\//, "");
          subjects = parseAttendance((await client.get(url)).data);
        } catch (_) {}
      }
    }
    return res.json({ success: true, profile, subjects, message: subjects.length === 0 ? "Login successful but attendance data could not be fetched." : null });
  } catch (err) {
    console.error("Vampire error:", err.message);
    return res.status(500).json({ error: "Could not connect to UIMS. The portal may be down.", details: err.message });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok", name: "Vampire" }));

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log("Vampire running on port " + PORT));
