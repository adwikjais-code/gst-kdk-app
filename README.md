# GST Client & Filing Tracker — Full System (App + KDK Engine)

KDK software jaisa complete setup — **login-protected GST tracker** + **background KDK Engine**
jo GST Portal ko headless automate karta hai: ID+password auto-fill → Captcha → SMS OTP →
sara data auto-sync (TDS/TCS, Notices, Ledgers) → GSTR-1 auto-upload → 1-click downloads.
**GST portal ka page aapke saamne kabhi nahi khulta — sab app ke andar hi hota hai.**

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  WEB APP (static, single    │  HTTPS  │  KDK ENGINE (Node.js)            │
│  file index.html)           │ ──────► │  demo mode  → simulated portal   │
│  • Strong password lock     │  /api/  │  live mode  → real gst.gov.in    │
│  • Clients + fees tracker   │  kdk/*  │  (headless Playwright browser)   │
│  • GSTR-1 JSON generator    │ ◄────── │  → captcha img, sync data,       │
│  • Master Etsy editor       │  JSON   │    GSTR-1 upload ACK, downloads  │
│  • ⚡ KDK Portal Hub        │ + files │                                  │
└─────────────────────────────┘         └──────────────────────────────────┘
```

## File Structure

```
gst-tracker-web/
├── index.html            ← THE APP (self-contained, no build step)
├── .nojekyll             ← GitHub Pages
├── README.md
├── archive/              ← purani app versions (reference)
└── engine/               ← KDK GST ENGINE (Node.js backend)
    ├── server.js
    ├── src/  (demo, gstportal-live, captcha, files, store)
    ├── render.yaml       ← one-click Render blueprint
    ├── sample.env
    ├── test-e2e.js       ← 20-check end-to-end test
    └── README.md         ← engine docs + live-mode notes
```

## Run Everything Locally (1 command)

```bash
cd engine
npm install
npm start                 # → http://localhost:7860
```

Ek hi server par app + engine — **engine URL set karne ki zaroorat nahi**,
app same-origin engine ko khud detect kar leta hai.

E2E test: `cd engine && node test-e2e.js`

## App Me KDK Flow (exactly KDK software jaisa)

1. **⚡ KDK Portal Hub** tab kholo → client select karo → **⚡ Sync**
2. App: *"Background Engine GST Portal khol raha hai aur ID + Password bhar raha hai..."*
3. **Captcha image app ke andar** dikhti hai (portal ka page nahi)
4. 6-digit code dalo (6th digit par auto-submit)
5. ✅ Captcha verify → **SMS-OTP card** dikhta hai → wahi box me OTP dalo
6. **Sab sync ho gaya**: TDS/TCS records, Notices, Cash/Credit ledger — tables me aa gaya
7. Agar GSTR-1 JSON queue ki thi → **auto-upload** + ACK reference
8. **1-click downloads**: Notice PDF, GSTR-2B JSON, GSTR-3B, GSTR-1 summary

## Deployment (Free)

### 1) Frontend — Cloudflare Pages (recommended)
- [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git** → repo
- **Build command: khali**, **Output dir: `/`**
- URL: `https://<name>.pages.dev` (custom domain free)

### 2) Engine — Render (blueprint ready)
- [render.com](https://render.com) → **New → Blueprint** → repo → `engine/render.yaml`
- demo mode: light install, free tier chalta hai
- live mode: `render.yaml` me live lines uncomment (Playwright install)
- URL: `https://kdk-gst-engine.onrender.com`

### 3) Connect (one-time)
- App me **⚡ KDK Portal Hub → Engine badge** dabao → engine URL paste → **Engine Connected ✓**
- (Agar app+engine same origin par host ho — jaise local ya Render full-stack — to URL ki zaroorat hi nahi)

**Alternative hosts:** Netlify / Vercel / GitHub Pages (frontend) · Railway / Fly.io / India VPS (engine, live mode ke liye VPS best)

> 📌 **Live mode notes** (real portal): datacenter IPs aksar block hote hain — live mode
> ke liye India-based VPS/recommendation. DOM change par `engine/src/gstportal.js` ka `SEL`
> block update hota hai (debug screenshots `data/debug/` me). Demo mode hamesha kaam karta hai.

## First-Run (naya device)

1. **Strong password set** karo (device-local lock)
2. **Apps Script URL** connect karo (Settings) → clients Google Sheet se sync
3. Har client me **Portal ID + GST Password** set karo (✏️ Edit) — in-app login inhi se hota hai
4. ⚡ KDK Portal Hub me sync karo — bas!

## Security Notes

- App password = device-local (UI lock). Real data Google Sheet/Apps Script me hai → Sheet **Private**,
  Apps Script **execute-as-me** rakho.
- Repo public hai (free hosting) — code me koi secret nahi (sab client-side / aapke script me). ✅
- Engine production me: `CORS_ORIGINS` apni app par set karo; chahein to Render **Basic Auth** laga do.

## Version History

- **v43 + KDK Engine (current)** — complete KDK-style in-app login/sync system
- v42 / v41 / v2 / v1 — purani builds (Drive me: `gst_tracker_*.zip`, aur `archive/` me)
