# KDK GST Web App — Project Notes (Agent Handoff)

> Ye file naye chat/session me project continue karne ke liye hai.
> Isko pehle padho, phir kaam shuru karo.

## 📌 Kya hai yeh project

Ek web app jo **KDK software** jaisa kaam karta hai: GST portal login + GSTR-1/GSTR-2B data fetch + TDS/TCS credit tracking + notices.
**Special cheez:** GST portal ka page user ko KABHI nahi dikhta — sab kuch **headless background engine** me hota hai. User sirf **captcha + OTP** enter karta hai app ke andar (in-app modal).

## 🔗 Live URLs

| Kya | URL |
|-----|-----|
| Frontend (GitHub Pages) | `https://adwikjais-code.github.io/gst-kdk-app/` |
| Background Engine (Render, Docker) | `https://gst-kdk-app.onrender.com` |
| GitHub repo (public, Pages se serve hota hai) | `github.com/adwikjais-code/gst-kdk-app` |

- Engine status: `GET /api/kdk/status` → `{"ok":true,"mode":"live",...}`
- Debug: `GET /api/kdk/debug` → screenshots list + last scrape trace
- Debug screenshots: `GET /debug/<filename>`
- Client vault list: `GET /api/kdk/clients`
- Live progress: `GET /api/kdk/progress?sessionId=<id>`
- Results store: `GET /api/kdk/results`

## 🏗️ Architecture

```
index.html (single-file frontend, ~1MB, Tailwind CDN, localStorage store)
    │  fetch (CORS open)
    ▼
engine/ (Node + Express + Playwright headless Chromium)
    ├── server.js        → /api/kdk/* endpoints, static serve
    ├── src/gstportal.js → LIVE mode: real GST portal automation (sab kuch yahan hai)
    ├── src/demo.js      → DEMO mode: fake data (UI test ke liye)
    ├── src/store.js     → data/store.json (clients, vault, queue)
    └── Dockerfile       → Render deploy (node:20-slim + playwright chromium)
```

- **MODE env var** (Render): `live` = real portal, `demo` = fake. **Currently: live.**
- Frontend me default engine URL hardcoded: `https://gst-kdk-app.onrender.com` (zero-setup).
- Client credentials (Portal ID + Password) engine me **vault** me save hote hain (har init-login par). Naye device me clients auto-restore hote hain (`/api/kdk/clients` merge).

## 🔁 Sync Flow (frontend ↔ engine ↔ portal)

1. User: ⚡ KDK Portal Hub → client select → **⚡ Auto-Login & Sync**
2. Frontend → `POST /api/kdk/init-login` {gstin, username, password, clientName, fp}
   - Engine: Playwright se `services.gst.gov.in/services/login` kholta hai, ID+password bharta hai, LOGIN click
   - Response: portal ka **real captcha image** (base64)
3. User captcha daalta hai → `POST /api/kdk/submit-sync` {sessionId, captcha}
   - Portal **SMS OTP** maangta hai → engine OTP prompt + progress return karta hai
4. User OTP daalta hai → same endpoint
   - Login complete → **scrapeAll** chalta hai (har step screenshot + table dump):
     - Auth Dashboard (`services.gst.gov.in/services/auth/dashboard`) → **Cash/ITC ledger balances** (row-label extraction)
     - Returns Dashboard (`return.gst.gov.in/returns/auth/dashboard`) → FY/Quarter/Month form auto-fill + SEARCH → **GSTR-1/3B due dates + status** (div cards, text regex)
     - Notices (`services.gst.gov.in/services2/auth/getlistofnotices`)
     - **GSTR-2B card DOWNLOAD button → GSTR-2B JSON download → `tds_tcs` section parse** (Etsy TCS yahan se aati hai)
     - ECO supplies page (`services/auth/suppliesbyecodetails`) — backup TDS/TCS source
     - GSTR-1 auto-upload (agar queue me file hai)
   - Response: full data object (frontend merge karta hai localStorage me)

**Long sync problem:** Render free tier proxy ~100s pe request cut karta hai. Frontend me **recovery polling** hai (fetch fail ho to `/api/kdk/results` poll karta hai har 10s). **Live progress** bhi aata hai (`/api/kdk/progress` poll har 3s → statusBox me step + %).

## ⚠️ Known Issues / Pending (in order of priority)

1. **Etsy TCS (GSTR-2B JSON download)** — code ready hai (`g2b-download` + `g2b-json-parsed` trace steps) par **successful sync trace abhi nahi mila** verify karne ke liye. Next live sync ke baad `last-tables-*` + trace check karo. Agar download button kaam na kare to GSTR-2B card ka HTML `last-anchors-returns-dash.json` se dekho.
2. **WAF blocks:** `gstr2b.gst.gov.in` (GSTR-2B statement app) headless ko silently blank render karta hai (AngularJS crash). Statement page use mat karo — **JSON download** hi rasta hai. Kuch return.gst.gov.in paths bhi kabhi-kabhi WAF reject karte hain (direct goto par) — isliye `visit()` helper me menu-click fallback hai.
3. **Render free tier:** idle 15 min → spin-down → pehla request ~50s cold start. Normal hai.
4. **Notices page** Angular SPA hai — networkidle wait laga hai; kuch clients par content slow render hota hai.

## 🐛 Debug System (selectors fix karne ke liye)

Har sync ke baad `data/debug/` me:
- `*_<step>.png` screenshots (har page ka)
- `last-scrape-trace.json` — har step ka log (URL, detail)
- `last-tables-<step>.json` — har page ke tables (raw rows)
- `last-anchors-<step>.json` — saare links (text + href)

Engine se uthao: `curl https://gst-kdk-app.onrender.com/api/kdk/debug`

**Important:** Har GitHub push par Render redeploy hota hai → **data/ directory WIPE hoti hai** (screenshots, vault, store). Yeh expected hai.

## 🚀 Deploy Process

1. Code edit karo → `git push` (repo: adwikjais-code/gst-kdk-app, branch main)
2. GitHub Pages **automatic** update (frontend)
3. Render **automatic** redeploy (~1.5 min, Docker build)
4. Verify: `curl https://gst-kdk-app.onrender.com/api/kdk/status` → `mode: live`
5. User ko fresh cache ke saath kaho: `...gst-kdk-app/?v=N` (N badhao har baar)

**Render config yaad rakho:** Runtime = **Docker** (Settings → Build → Source → Edit), root dir `engine/`, env `MODE=live`. Native runtime mat wapas karo (Playwright install fail hota hai: `su: Authentication failure`).

## 📝 Clients (yaad rahe)

- Real clients browser localStorage me + engine vault me hain (repo me NAKI — repo public hai).
- Test client jiska data verify hua: RUHAN ANSARI (09ELEPA6475C1Z7) — Cash ₹111, ITC ₹0, GSTR-1 10/2026 OVERDUE (due 11/11/2026), GSTR-3B due 20/11/2026, notices 0. **Etsy se TCS credit aayi hai** (user confirm) — woh GSTR-2B me accept hone ka wait kar rahi hai.
- NEHA BANO (09IGEPB7916N1ZU, Portal ID: AdNeha2026) — pehla test client tha.

## ✅ Verified Working (2026-11-15)

- Real portal login (captcha + SMS OTP) headless me ✅
- Ledger balances (Cash ₹111 real data) ✅
- GSTR-1/3B status + due dates + OVERDUE flag ✅
- Notices (0 dikhaya, page loads) ✅
- Client vault + auto-restore + default engine URL (zero-setup naye device) ✅
- Live progress UI + recovery polling ✅
- Demo mode se live mode confusion nahi (DEMO labels) ✅
