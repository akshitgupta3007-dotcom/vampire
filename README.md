# 🧛 Vampire
**Private Chitkara Chalkpad tracker — by Akshit Gupta**

Clean. Minimal. Black & white. Just username + password, nothing else.

---

## What it does

- Logs into Chalkpad (punjab.chitkara.edu.in) using only username & password
- Institute and session are **hardcoded** (no need to select them)
- Shows subject-wise attendance % with bunk/need calculator
- Credentials are never stored — fresh session each time

---

## Run locally

```bash
cd backend
npm install
npm start
# open http://localhost:3001
```

---

## Deploy free on Railway (recommended)

1. Push this folder to a private GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. **Build command:** `cd backend && npm install`
4. **Start command:** `cd backend && node server.js`
5. Railway gives you a public URL — share with your friends

---

## Customise institute / session

The backend auto-picks the latest session from Chalkpad's login page.
If you need to force a specific institute code, set env vars on Railway:

```
INSTITUTE=CIET
SESSION=2024-25
```

Common Chitkara Punjab institute codes seen on the portal:
`CIET`, `CSHSU(N)`, `CDSGE`, `SECCC`, `ECSHP`, `HDCSCA`, etc.

---

## Project structure

```
vampire/
├── backend/
│   ├── server.js      ← Express API + Chalkpad scraper
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html ← Full UI (single file)
├── Procfile
└── README.md
```

---

*Private. Not affiliated with Chitkara University.*
