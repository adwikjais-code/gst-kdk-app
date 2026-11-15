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

const LOGIN_URL = process.env.LOGIN_URL || "https://services.gst.gov.in/services/login";
const DASH_URL = process.env.DASH_URL || "https://services.gst.gov.in/services/dash";
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT_MS || 30000);

// ---- selectors (verified 2026-11-15 against services.gst.gov.in) ----
const SEL = {
  loginId: ["#username", "input[name='user_name']", "input[placeholder*='Username' i]"],
  loginPassword: ["#user_pass", "input[name='user_pass']", "input[placeholder*='Password' i]"],
  loginBtn: ["button:has-text('LOGIN')", "input[type='submit']", "button[type='submit']"],
  captchaImg: ["img[id*='captcha' i]", "img[name*='captcha' i]", "img[class*='captcha' i]", "img[src*='captcha' i]"],
  captchaInput: ["input[name='captcha']", "input[id*='captcha' i]", "input[placeholder*='Captcha' i]"],
  otpInput: ["input[name*='otp' i]", "input[id*='otp' i]", "input[placeholder*='OTP' i]", "input[inputmode='numeric']"],
  otpBtn: ["button:has-text('Verify')", "button:has-text('Submit')", "input[type='submit']", "button[type='submit']"],
  dashboard: ["#dashboard", "a[href*='dash']", "[class*='dashboard' i]", "text=Dashboard"],
  errorText: ["[class*='alert-danger']", "[class*='error']", "text=/invalid|incorrect|wrong|not valid|try again/i"],
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
  let context = null;
  try {
    context = await pw.chromium.launchPersistentContext("", {
      headless: HEADLESS,
      viewport: { width: 1366, height: 900 },
      locale: "en-IN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT * 2 });
    await page.waitForTimeout(2500);

    const idEl = await firstVisible(page, SEL.loginId);
    const pwEl = await firstVisible(page, SEL.loginPassword);
    await idEl.fill(username);
    await pwEl.fill(password);
    await page.waitForTimeout(600);
    await (await firstVisible(page, SEL.loginBtn, 8000)).click();

    // wait for portal reaction: captcha screen / otp screen / error / dashboard
    await page.waitForTimeout(5000);
    const state = await detectStage(page);

    if (state === "captcha") {
      const captchaImage = await grabCaptchaImage(page);
      const f = await snap(page, "after-login-click");
      if (!captchaImage) {
        await context.close().catch(() => {});
        return { ok: false, error: "Captcha screen mila lekin captcha image nahi mila. Debug: " + (f ? path.basename(f) : "-") };
      }
      SESSIONS.set(id, { id, gstin, username, password, clientName, fp, context, page, stage: "captcha", createdAt: Date.now(), lastUsed: Date.now(), keepAlive: false });
      return { ok: true, sessionId: id, captchaImage };
    }
    if (state === "otp") {
      SESSIONS.set(id, { id, gstin, username, password, clientName, fp, context, page, stage: "otp", createdAt: Date.now(), lastUsed: Date.now(), keepAlive: false });
      const f = await snap(page, "otp-screen");
      return { ok: false, error: "✅ ID+Password theek! Ab <b>SMS/Email par aaya 6-digit OTP</b> same box me dalein:", captchaImage: f ? await pngDataUrl(page, f) : null };
    }
    if (state === "dashboard") {
      SESSIONS.set(id, { id, gstin, username, password, clientName, fp, context, page, stage: "logged_in", createdAt: Date.now(), lastUsed: Date.now(), keepAlive: false });
      return { ok: false, error: "✅ Login turant complete ho gaya (captcha/OTP nahi chahiye) — ab bas wahi box me koi bhi 6-digit dal kar sync karein:" };
    }

    // error / unexpected
    const errText = await firstText(page, SEL.errorText, 2000);
    const f = await snap(page, "login-failed");
    await context.close().catch(() => {});
    return {
      ok: false,
      error: (errText ? "❌ Portal error: " + errText.trim().slice(0, 200) : "❌ Portal ka response unexpected tha (invalid credentials ya bot-block).") + " Debug: " + (f ? path.basename(f) : "-"),
    };
  } catch (e) {
    if (context) await context.close().catch(() => {});
    return { ok: false, error: "Portal open failed: " + e.message };
  }
}

// detect what portal is showing after a login action
async function detectStage(page) {
  // dashboard first
  for (const s of SEL.dashboard) {
    try { if (await page.locator(s).first().isVisible({ timeout: 1500 })) return "dashboard"; } catch { /* next */ }
  }
  for (const s of SEL.otpInput) {
    try { if (await page.locator(s).first().isVisible({ timeout: 1500 })) return "otp"; } catch { /* next */ }
  }
  for (const s of SEL.captchaInput) {
    try { if (await page.locator(s).first().isVisible({ timeout: 1500 })) return "captcha"; } catch { /* next */ }
  }
  for (const s of SEL.captchaImg) {
    try { if (await page.locator(s).first().isVisible({ timeout: 1000 })) return "captcha"; } catch { /* next */ }
  }
  return "unknown";
}

async function grabCaptchaImage(page) {
  for (const s of SEL.captchaImg) {
    try {
      const img = page.locator(s).first();
      if (await img.isVisible({ timeout: 2500 })) {
        const src = await img.getAttribute("src");
        if (src && src.startsWith("data:")) return src;
        if (src) {
          try { return (await img.screenshot({ type: "png" })).toString("base64") && "data:image/png;base64," + (await img.screenshot({ type: "png" })).toString("base64"); }
          catch { /* ignore */ }
        }
      }
    } catch { /* next */ }
  }
  // fallback: screenshot the region around captcha input
  try {
    const inp = page.locator(SEL.captchaInput[0]).first();
    if (await inp.isVisible({ timeout: 1500 })) {
      const box = await inp.boundingBox();
      if (box) {
        const buf = await page.screenshot({ clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 90), width: Math.min(320, 400), height: 140 } });
        return "data:image/png;base64," + buf.toString("base64");
      }
    }
  } catch { /* ignore */ }
  return null;
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
      await page.waitForTimeout(4000);
      const state = await detectStage(page);

      if (state === "otp") {
        s.stage = "otp";
        const f = await snap(page, "otp-step");
        return {
          ok: false,
          error: "✅ Captcha theek! Ab <b>SMS/Email par aaya 6-digit OTP</b> same box me dalein (6th digit par auto-submit):",
          captchaImage: f ? await pngDataUrl(page, f) : null,
        };
      }
      if (state === "dashboard") {
        s.stage = "logged_in";
        const data = await scrapeAll(s, page, fp || s.fp, autoUploadGstr1);
        const store = load();
        store.clients[s.gstin] = data;
        save();
        return { ok: true, sessionId, data };
      }
      // wrong captcha / error
      const errText = await firstText(page, SEL.errorText, 2500);
      const f2 = await snap(page, "after-captcha");
      const newCap = await grabCaptchaImage(page);
      return {
        ok: false,
        error: "❌ " + (errText ? "Portal: " + errText.trim().slice(0, 150) : "Captcha portal ne reject kiya — naya code dobara dalein."),
        captchaImage: newCap || (f2 ? await pngDataUrl(page, f2) : null),
      };
    }

    if (s.stage === "otp") {
      const inp = await firstVisible(page, SEL.otpInput, 8000);
      await inp.fill(code);
      await (await firstVisible(page, SEL.otpBtn, 8000)).click();
      await page.waitForTimeout(5000);
      const state = await detectStage(page);
      if (state !== "dashboard") {
        const errText = await firstText(page, SEL.errorText, 2500);
        const f = await snap(page, "after-otp");
        return {
          ok: false,
          error: "❌ " + (errText ? errText.trim().slice(0, 150) : "OTP verify nahi hua ya dashboard nahi khula.") + " Screenshot: " + (f ? path.basename(f) : "-"),
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

  // helper: grab all visible table rows (>= n cols)
  const grabRows = (minCols = 3) => page.evaluate((mc) => {
    const out = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const tds = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
      if (tds.length >= mc) out.push(tds);
    });
    return out;
  }, minCols);

  // helper: click a menu item by text, wait for content
  async function clickMenu(label, waitMs = 4500) {
    const candidates = [
      `li:has-text('${label}')`, `a:has-text('${label}')`, `span:has-text('${label}')`,
      `[class*='menu' i] :has-text('${label}')`, `text=${label}`,
    ];
    for (const sel of candidates) {
      try {
        const el = page.locator(sel).last();
        if (await el.isVisible({ timeout: 1200 })) {
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(waitMs);
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  }

  // 0) ensure we are on dashboard
  try {
    if (!/dash/i.test(page.url())) await page.goto(DASH_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    await page.waitForTimeout(4000);
    await snap(page, "dash-landed");
  } catch (e) { await snap(page, "dash-err").catch(() => {}); }

  // 1) Ledger balances from dashboard text
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const cashM = bodyText.match(/Cash Ledger[^\d\-]*([\-0-9,\.]+)/i) || bodyText.match(/Cash Balance[^\d\-]*([\-0-9,\.]+)/i);
    const creditM = bodyText.match(/Input Tax Credit[^\d\-]*([\-0-9,\.]+)/i) || bodyText.match(/ITC[^\d\-]*([\-0-9,\.]+)/i);
    base.cashLedgerBalance = cashM ? num(cashM[1]) : 0;
    base.creditLedgerBalance = creditM ? num(creditM[1]) : 0;
    base.dashboardTextSnippet = bodyText.slice(0, 800);
  } catch { /* ignore */ }

  // 2) Notices — try menu then tables on dashboard
  try {
    let rows = await grabRows(4);
    if (!rows.length) {
      if (await clickMenu("Notices")) rows = await grabRows(4);
    }
    for (const tds of rows.slice(0, 15)) {
      if (/notice|demand|intimation|DRC|ADT|ASMT/i.test(tds.join(" "))) {
        base.notices.push({
          refId: tds[0] || "NOTICE", type: tds[1] || "Notice", description: tds[2] || "",
          issueDate: tds[3] || "-", dueDate: tds[4] || "-", status: "Pending Action",
        });
      }
    }
  } catch (e) { await snap(page, "notices-err").catch(() => {}); }

  // 3) TDS/TCS (GSTR-2B / RCM) — menu then tables
  try {
    if (await clickMenu("GSTR-2B")) {
      const rows = await grabRows(4);
      for (const tds of rows.slice(0, 15)) {
        const total = num(tds[tds.length - 1]);
        if (!total && !/tcs|tds/i.test(tds.join(" "))) continue;
        base.tdsTcsRecords.push({
          type: /tcs/i.test(tds.join(" ")) ? "TCS" : "TDS", ctin: tds[0] || "-", cname: tds[1] || "-",
          net: num(tds[2]), iamt: num(tds[3]), camt: 0, samt: 0, totalCredit: total, status: "Pending Action",
        });
      }
    }
  } catch (e) { await snap(page, "gstr2b-err").catch(() => {}); }

  // 4) GSTR-1 auto-upload (queued JSON)
  if (autoUploadGstr1) {
    const store = load();
    const q = store.gstr1Queue[s.gstin + "_" + (fp || "")];
    if (q && q.status === "QUEUED") {
      try {
        const tmp = path.join(DATA_DIR, `gstr1_${s.gstin}_${Date.now()}.json`);
        fs.writeFileSync(tmp, q.jsonContent);
        let opened = await clickMenu("GSTR-1");
        const fileInput = page.locator("input[type='file']").first();
        if (opened && await fileInput.isVisible({ timeout: 8000 })) {
          await fileInput.setInputFiles(tmp);
          await page.waitForTimeout(2000);
          const submit = page.locator("button:has-text('Submit'), input[type='submit']").first();
          if (await submit.isVisible({ timeout: 5000 })) {
            await submit.click();
            await page.waitForTimeout(10000);
            const ack = (await page.evaluate(() => document.body.innerText || "")).match(/(ACK[A-Z0-9]{8,})/i);
            q.status = "UPLOADED";
            q.uploadRefId = ack ? ack[1] : "SUBMITTED";
            q.uploadedAt = iso();
            save();
            base.gstr1Upload = { status: "UPLOADED", refId: q.uploadRefId, fileName: q.fileName, fp: fp || "", uploadedAt: q.uploadedAt, mode: "Auto-Upload (KDK Engine)" };
          }
        } else {
          base.gstr1Upload = { status: "PENDING", refId: "", fileName: q.fileName, error: "GSTR-1 page ka file-upload nahi mila (menu/selector update chahiye)" };
          await snap(page, "gstr1-nofind").catch(() => {});
        }
      } catch (e) {
        base.gstr1Upload = { status: "FAILED", refId: "", fileName: q.fileName, error: e.message };
        await snap(page, "gstr1-upload-err").catch(() => {});
      }
    }
  }

  await snap(page, "scrape-done").catch(() => {});
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
