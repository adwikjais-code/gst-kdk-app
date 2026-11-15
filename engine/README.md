# ⚡ KDK GST Engine (Backend)

Aapke **GST Client & Filing Tracker** web app ka background engine — KDK software jaisa
**in-app GST Portal login + auto data sync**, bina GST portal ka page kabhi dikhaye:

```
App (frontend)  →  init-login   →  Engine: ID + Password portal me auto-fill
                  →  captcha img ←  (6-digit GST captcha image aapke app me dikhta hai)
                  →  submit     →  Engine: captcha submit → SMS-OTP step
                  →  OTP enter  →  Engine: login complete → TDS/TCS + Notices + Ledgers khinch
                                    → queued GSTR-1 JSON auto-upload → ACK milta hai
                  →  1-click    →  NOTICE PDF / GSTR-2B JSON / GSTR-3B / GSTR-1 download
```

## Two Modes

| Mode | Kya karta hai | Kab use karein |
|---|---|---|
| **`demo`** (default) | GST portal ki full simulation — real captcha + SMS-OTP flow, realistic data, GSTR-1 auto-upload, 1-click downloads. Zero dependencies, 100% offline. | Testing, client demo, deployment pehle aane tak |
| **`live`** | Real `gst.gov.in` automation via headless Playwright (Chromium). | Production — real logins chahiye ho |

```bash
# demo (default)
npm start

# live — pehle install:
npm install playwright
npx playwright install chromium --with-deps
MODE=live npm start
```

## API (frontend contract — app exactly yahi call karta hai)

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/kdk/status` | — | `{ ok, mode, activeSessions }` |
| `GET /api/kdk/results` | — | `{ ok, store: { clients, gstr1Queue } }` |
| `POST /api/kdk/init-login` | `{ gstin, username, password, clientName, fp, demoMode }` | `{ ok, sessionId, captchaImage }` / `{ ok:false, error }` |
| `POST /api/kdk/submit-sync` | `{ sessionId, captcha, fp, autoUploadGstr1, keepAliveForDownloads }` | stage-1: captcha verify → `{ ok:false, error:"ab OTP dalein", captchaImage:SMS }` · stage-2: `{ ok:true, data:{ gstin, tdsTcsRecords, notices, cashLedgerBalance, creditLedgerBalance, gstr1Upload… } }` · wrong: `{ ok:false, error, captchaImage }` |
| `POST /api/kdk/queue-gstr1` | `{ gstin, fp, fileName, jsonContent }` | `{ ok, queued }` — next successful login par auto-upload |
| `POST /api/kdk/download-item` | `{ sessionId, gstin, itemType, refId, fp }` | `{ ok, downloadUrl, fileName }` / `{ ok:false, needRelogin }` · itemType: `NOTICE`, `GSTR2B_JSON`, `GSTR3B_SUMMARY`, `GSTR1_SUMMARY` |

Static: `GET /downloads/<file>` (1-click files) · `GET /debug/<png>` (live-mode failure screenshots)

## Env vars

| Var | Default | Note |
|---|---|---|
| `PORT` | `7860` | App port 3000/7860 par same-origin serve hote to engine auto-detect |
| `MODE` | `demo` | `demo` \| `live` |
| `HEADLESS` | `true` | live: browser hidden |
| `CORS_ORIGINS` | *(allow all)* | production me apni app origins dein: `https://yourapp.pages.dev` |
| `PORTAL_URL` | `https://www.gst.gov.in/` | live mode |
| `STEP_TIMEOUT_MS` | `25000` | live mode per-step timeout |

## Local run

```bash
cd engine
npm install
npm start            # → http://localhost:7860  (app bhi same server serve karta hai)
```

E2E test (20 checks): `node test-e2e.js`

## Deploy — Render (blueprint ready)

1. Repo GitHub par push karo.
2. [render.com](https://render.com) → **New → Blueprint** → repo select → `render.yaml` pick.
   - **demo mode**: `npm install --omit=optional` (fast, light)
   - **live mode**: `npm install && npx playwright install chromium --with-deps` + `MODE=live`
3. Engine URL milega: `https://kdk-gst-engine.onrender.com`
4. App me **⚡ KDK Portal Hub → Engine badge** → URL paste → **Engine Connected ✓**

> ⚠️ **Live mode honest notes:**
> - gst.gov.in strong bot-detection + captcha lagata hai. Datacenter IPs (Render/Railway free tier)
>   aksar block hote hain — live mode ka best result **India-based VPS / residential IP** par milta hai.
> - Portal UI regularly badalta hai. Agar selectors break ho jayein: `data/debug/*.png` screenshots
>   dekho, aur `src/gstportal.js` ke upar `SEL` block me selectors update karo.
> - Demo mode hamesha kaam karega — flow, UI, downloads sab end-to-end testable hai.

## Security

- Engine koi credentials store nahi karta — login ke liye password app se har baar aata hai (frontend localStorage se).
- `data/store.json` me sirf sync results + queued JSON files (aapka apna data).
- CORS ko production me apni app ki origin par restrict karna.
- Engine URL kisi public link me share na karein; chahein to Render par Basic Auth (site protection) laga sakte ho.
