// ============================================================
// KDK ENGINE — LIVE MODE (Real GST Portal via headless Playwright)
// ------------------------------------------------------------
// NOTE:
// 1) Install:  npm install playwright && npx playwright install chromium --with-deps
// 2) GST Portal (gst.gov.in) uses aggressive bot detection + captcha.
//    Datacenter IPs (Render/Railway) are often blocked — best results come
//    from an India-based VPS / residential-IP box. Portal DOM changes
//    regularly: if selectors break, update the SEL block below (open
//    data/debug/*.png screenshots to see where it stopped).
// 3) Flow (matches frontend exactly, one 6-digit input):
//    init-login → portal fills ID+password → returns portal captcha image
//    submit-sync (captcha) → portal shows SMS-OTP screen → engine returns
//    ok:false with a screenshot of the OTP step
//    submit-sync (otp) → login done → scrape TDS/TCS + Notices + Ledgers,
//    optionally auto-upload queued GSTR-1 JSON.
// ============================================================
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { load, save, DATA_DIR } = require("./store");

const PORTAL_URL = process.env.PORTAL_URL || "https://www.gst.gov.in/";
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT_MS || 25000);

// ---- selectors (update here when portal UI changes) ----
const SEL = {
  loginId: ["input[name='loginId']", "input[name='username']", "#loginId", "input[placeholder*='GSTIN' i]"],
  loginPassword: ["input[name='password']", "#password", "input[type='password']"],
  captchaImg: ["img[class*='captcha' i]", "img[id*='captcha' i]", "img[src*='captcha' i]"],
  captchaInput: ["input[name='captcha']", "#captcha", "input[placeholder*='captcha' i]", "input[autocomplete='off']"],
  loginBtn: ["button[type='submit']", "input[type='submit']", "button:has-text('Login')", "button:has-text('Sign in')"],
  otpInput: ["input[name*='otp' i]", "input[placeholder*='OTP' i]", "#otp", "input[inputmode='numeric']"],
  otpBtn: ["button[type='submit']", "button:has-text('Verify')", "button:has-text('Submit')"],
  dashboard: ["[class*='dashboard' i]", "#dashboard", "a[href*='#dashboard']", "text=Dashboard"],
};

const DEBUG_DIR = path.join(DATA_DIR, "debug");
function ensureDebug() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}
async function snap(page, tag) {
  try {
    ensureDebug();
    const f = path.join(DEBUG_DIR, `${Date.now()}_${tag}.png`);
    await page.screenshot({ path: f, fullPage: true });
    return f;
  } catch { return null; }
}
async function firstVisible(page, sels, timeout = STEP_TIMEOUT) {
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: Math.min(timeout, 3000) })) return el;
    } catch { /* next */ }
  }
  throw new Error("element not found: " + sels.join(" | "));
}
async function firstText(page, sels, timeout = STEP_TIMEOUT) {
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: Math.min(timeout, 3000) })) return el.innerText({ timeout: 2000 });
    } catch { /* next */ }
  }
  return null;
}
function num(s) {
  const m = String(s || "").replace(/[^0-9.\-]/g, "");
  const v = parseFloat(m);
  return isFinite(v) ? v : 0;
}

const SESSIONS = new Map();
const TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);

function iso(d = new Date()) { return d.toISOString(); }
function fmtDate(d) {
  return String(d.getDate()).padStart(2, "0") + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + d.getFullYear();
}

function isAlive(s) { return s && Date.now() - s.lastUsed < (s.keepAlive ? TTL_MS * 24 : TTL_MS); }

// ---------- init ----------
async function initLogin({ gstin, username, password, clientName, fp }) {
  let pw;
  try { pw = require("playwright"); }
  catch { return { ok: false, error: "Playwright not installed. Run: npm install playwright && npx playwright install chromium --with-deps" }; }

  if (!gstin || !username || !password) return { ok: false, error: "Portal ID / Password missing — client me set nahi hai." };

  const id = crypto.randomUUID();
  try {
    const context = await pw.chromium.launchPersistentContext("", {
      headless: HEADLESS,
      viewport: { width: 1366, height: 900 },
      locale: "en-IN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT * 2 });
    await page.waitForTimeout(1500);

    const idEl = await firstVisible(page, SEL.loginId);
    const pwEl = await firstVisible(page, SEL.loginPassword);
    await idEl.fill(username);
    await pwEl.fill(password);
    await page.waitForTimeout(800);

    // grab portal captcha image
    let captchaImage = null;
    for (const s of SEL.captchaImg) {
      try {
        const img = page.locator(s).first();
        if (await img.isVisible({ timeout: 4000 })) {
          const src = await img.getAttribute("src");
          if (src && src.startsWith("data:")) captchaImage = src;
          else if (src) {
            try { captchaImage = await img.screenshot({ type: "png" }).then((b) => "data:image/png;base64," + b.toString("base64")); }
            catch { /* ignore */ }
          }
          break;
        }
      } catch { /* next */ }
    }
    if (!captchaImage) {
      const f = await snap(page, "init");
      await context.close().catch(() => {});
      return { ok: false, error: "Portal login form load nahi hua (bot-block ya DOM change). Debug: " + (f ? path.basename(f) : "-") };
    }

    SESSIONS.set(id, { id, gstin, username, password, clientName, fp, context, page, stage: "captcha", createdAt: Date.now(), lastUsed: Date.now(), keepAlive: false });
    return { ok: true, sessionId: id, captchaImage };
  } catch (e) {
    return { ok: false, error: "Portal open failed: " + e.message };
  }
}

// ---------- submit (captcha step or otp step) ----------
async function submitSync({ sessionId, captcha, fp, autoUploadGstr1, keepAliveForDownloads }) {
  const s = SESSIONS.get(sessionId);
  if (!s || !isAlive(s) || !s.context) {
    SESSIONS.delete(sessionId);
    return { ok: false, needRelogin: true, error: "Session expire — dobara login karein." };
  }
  s.lastUsed = Date.now();
  if (keepAliveForDownloads) s.keepAlive = true;
  const page = s.page;
  const code = String(captcha || "").trim();

  try {
    if (s.stage === "captcha") {
      const inp = await firstVisible(page, SEL.captchaInput, 8000);
      await inp.fill(code);
      await (await firstVisible(page, SEL.loginBtn, 8000)).click();
      await page.waitForTimeout(2500);

      // OTP screen?
      let otpEl = null;
      for (const sel of SEL.otpInput) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 8000 })) { otpEl = el; break; }
        } catch { /* next */ }
      }
      if (otpEl) {
        s.stage = "otp";
        const f = await snap(page, "otp-step");
        return {
          ok: false,
          error: "✅ Captcha theek! Ab <b>SMS/Email par aaya 6-digit OTP</b> same box me dalein (6th digit par auto-submit):",
          captchaImage: f ? await pngDataUrl(page, f) : null,
        };
      }
      // maybe captcha was wrong → portal shows error
      const errText = await firstText(page, ["text=/galat|wrong|incorrect|invalid/i", "[class*='error' i]"], 3000);
      const f2 = await snap(page, "after-captcha");
      return {
        ok: false,
        error: "❌ " + (errText ? "Portal ne captcha reject kiya — naya code dobara dalein." : "Portal ka response unexpected tha (screenshot me dekhein)."),
        captchaImage: f2 ? await pngDataUrl(page, f2) : null,
      };
    }

    if (s.stage === "otp") {
      const inp = await firstVisible(page, SEL.otpInput, 8000);
      await inp.fill(code);
      await (await firstVisible(page, SEL.otpBtn, 8000)).click();
      await page.waitForTimeout(4000);

      let onDashboard = false;
      for (const sel of SEL.dashboard) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 10000 })) { onDashboard = true; break; }
        } catch { /* next */ }
      }
      if (!onDashboard) {
        const f = await snap(page, "after-otp");
        return {
          ok: false,
          error: "❌ OTP verify nahi hua ya dashboard nahi khula. Screenshot: " + (f ? path.basename(f) : "-"),
          captchaImage: f ? await pngDataUrl(page, f) : null,
        };
      }
      s.stage = "logged_in";
      const data = await scrapeAll(s, page, fp || s.fp, autoUploadGstr1);
      const store = load();
      store.clients[s.gstin] = data;
      save();
      return { ok: true, sessionId, data };
    }

    // already logged in
    const data = await scrapeAll(s, page, fp || s.fp, autoUploadGstr1);
    const store = load();
    store.clients[s.gstin] = data;
    save();
    return { ok: true, sessionId, data };
  } catch (e) {
    const f = await snap(page, "error").catch(() => null);
    return { ok: false, error: "Live sync error: " + e.message + (f ? ` (debug: ${path.basename(f)})` : "") };
  }
}

async function pngDataUrl(page, file) {
  try {
    const b = fs.readFileSync(file);
    return "data:image/png;base64," + b.toString("base64");
  } catch { return null; }
}

// ---------- scraping (best-effort, portal DOM varies) ----------
async function scrapeAll(s, page, fp, autoUploadGstr1) {
  const base = {
    gstin: s.gstin, clientName: s.clientName, fp: fp || "",
    syncedAt: iso(), cashLedgerBalance: 0, creditLedgerBalance: 0,
    tdsTcsRecords: [], notices: [], gstr1Upload: null, source: "kdk-engine-live",
  };

  // 1) Notices & Demands
  try {
    await page.goto(PORTAL_URL.replace(/[#/].*$/, "") + "#notices", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    await page.waitForTimeout(2500);
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("table tr").forEach((tr) => {
        const tds = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
        if (tds.length >= 4) out.push(tds);
      });
      return out;
    });
    for (const tds of rows.slice(0, 15)) {
      base.notices.push({
        refId: tds[0] || "NOTICE", type: tds[1] || "Notice", description: tds[2] || "",
        issueDate: tds[3] || "-", dueDate: tds[4] || "-", status: "Pending Action",
      });
    }
  } catch (e) { await snap(page, "notices-err").catch(() => {}); }

  // 2) RCM / TDS-TCS (GSTR-2B based)
  try {
    await page.goto(PORTAL_URL.replace(/[#/].*$/, "") + "#rcm", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    await page.waitForTimeout(2500);
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("table tr").forEach((tr) => {
        const tds = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
        if (tds.length >= 3) out.push(tds);
      });
      return out;
    });
    for (const tds of rows.slice(0, 15)) {
      const total = num(tds[tds.length - 1]);
      base.tdsTcsRecords.push({
        type: /tcs/i.test(tds.join(" ")) ? "TCS" : "TDS", ctin: tds[0] || "-", cname: tds[1] || "-",
        net: num(tds[2]), iamt: num(tds[3]), camt: 0, samt: 0, totalCredit: total, status: "Pending Action",
      });
    }
  } catch (e) { await snap(page, "rcm-err").catch(() => {}); }

  // 3) Ledger balances (Cash + Input Tax Credit)
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const cashM = bodyText.match(/Cash Ledger[^\d\-]*([\-0-9,\.]+)/i);
    const creditM = bodyText.match(/Input Tax Credit[^\d\-]*([\-0-9,\.]+)/i);
    base.cashLedgerBalance = cashM ? num(cashM[1]) : 0;
    base.creditLedgerBalance = creditM ? num(creditM[1]) : 0;
  } catch { /* ignore */ }

  // 4) GSTR-1 auto-upload (queued JSON)
  if (autoUploadGstr1) {
    const store = load();
    const q = store.gstr1Queue[s.gstin + "_" + (fp || "")];
    if (q && q.status === "QUEUED") {
      try {
        const tmp = path.join(DATA_DIR, `gstr1_${s.gstin}_${Date.now()}.json`);
        fs.writeFileSync(tmp, q.jsonContent);
        await page.goto(PORTAL_URL.replace(/[#/].*$/, "") + "#gstr1", { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
        await page.waitForTimeout(2500);
        const fileInput = page.locator("input[type='file']").first();
        if (await fileInput.isVisible({ timeout: 10000 })) {
          await fileInput.setInputFiles(tmp);
          await page.waitForTimeout(1500);
          const submit = page.locator("button:has-text('Submit'), input[type='submit']").first();
          if (await submit.isVisible({ timeout: 5000 })) {
            await submit.click();
            await page.waitForTimeout(8000);
            const ack = (await page.evaluate(() => document.body.innerText || "")).match(/(ACK[A-Z0-9]{8,})/i);
            q.status = "UPLOADED";
            q.uploadRefId = ack ? ack[1] : "SUBMITTED";
            q.uploadedAt = iso();
            save();
            base.gstr1Upload = { status: "UPLOADED", refId: q.uploadRefId, fileName: q.fileName, fp: fp || "", uploadedAt: q.uploadedAt, mode: "Auto-Upload (KDK Engine)" };
          }
        }
      } catch (e) {
        base.gstr1Upload = { status: "FAILED", refId: "", fileName: q.fileName, error: e.message };
        await snap(page, "gstr1-upload-err").catch(() => {});
      }
    }
  }

  return base;
}

// ---------- downloads ----------
async function downloadItem({ sessionId, gstin, itemType, refId, fp }) {
  const s = SESSIONS.get(sessionId);
  const alive = s && isAlive(s) && s.stage === "logged_in" && s.context;
  if (!alive) return { ok: false, needRelogin: true, error: "Portal session active nahi — Captcha/OTP dalte hi download ho jayega." };
  s.lastUsed = Date.now();
  // Live mode downloads reuse the same generators with live-scraped data
  const { noticePdf, gstr2bJson, gstr3bPdf, gstr1Pdf } = require("./files");
  const store = load();
  const cd = store.clients[gstin] || { clientName: s.clientName, gstin, tdsTcsRecords: [], notices: [], gstr1Upload: null };
  const period = fp || s.fp || "";
  try {
    if (itemType === "NOTICE") {
      const notice = (cd.notices || []).find((n) => n.refId === refId) || { refId: refId || "NOTICE", type: "Notice", description: "", issueDate: "-", dueDate: "-" };
      return { ok: true, ...noticePdf(cd.clientName, gstin, notice, period) };
    }
    if (itemType === "GSTR2B_JSON") return { ok: true, ...gstr2bJson(cd.clientName, gstin, cd.tdsTcsRecords, period) };
    if (itemType === "GSTR3B_SUMMARY") return { ok: true, ...gstr3bPdf(cd.clientName, gstin, cd, period) };
    if (itemType === "GSTR1_SUMMARY") return { ok: true, ...gstr1Pdf(cd.clientName, gstin, cd, period, store.gstr1Queue[gstin + "_" + period] || null) };
    return { ok: false, error: "Unknown item type: " + itemType };
  } catch (e) {
    return { ok: false, error: "Download failed: " + e.message };
  }
}

function queueGstr1({ gstin, fp, fileName, jsonContent }) {
  const store = load();
  const key = gstin + "_" + (fp || "");
  store.gstr1Queue[key] = { gstin, fp: fp || "", fileName: fileName || `GSTR1_${gstin}_${fp}.json`, jsonContent: String(jsonContent || ""), status: "QUEUED", queuedAt: iso(), updatedAt: iso() };
  save();
  return { ok: true, queued: true, key };
}

function status() {
  let active = 0;
  for (const s of SESSIONS.values()) if (isAlive(s) && s.stage === "logged_in") active++;
  return { ok: true, mode: "live", name: "KDK GST Engine (Live Portal)", activeSessions: active, time: iso() };
}
function results() {
  const store = load();
  return { ok: true, mode: "live", store: { clients: store.clients, gstr1Queue: store.gstr1Queue } };
}

module.exports = { initLogin, submitSync, downloadItem, queueGstr1, status, results };
