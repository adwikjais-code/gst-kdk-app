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
// ---- verified live-portal URLs (menu-anchored, 2026-11-15) ----
const U = {
  home: "https://www.gst.gov.in/",
  authDash: "https://services.gst.gov.in/services/auth/dashboard",
  returnsDash: process.env.RETURNS_DASH_URL || "https://return.gst.gov.in/returns/auth/dashboard",
  ledgersQuick: process.env.LEDGERS_QUICK_URL || "https://services.gst.gov.in/services/auth/quicklinks/ledgers",
  cashLedger: process.env.CASH_LEDGER_URL || "https://payment.gst.gov.in/payment/auth/ledger/cashledger",
  itcLedger: process.env.ITC_LEDGER_URL || "https://return.gst.gov.in/returns/auth/ledger/taxledger",
  notices: process.env.NOTICES_URL || "https://services.gst.gov.in/services2/auth/getlistofnotices",
  gstr1Guess: "https://return.gst.gov.in/returns/auth/gstr1",
  gstr2bGuess: "https://return.gst.gov.in/returns/auth/gstr2b",
};
const DASH_URL = U.returnsDash;
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
// ---------- live-portal helpers ----------
async function dismissPopup(page) {
  try {
    const p = page.locator("#lbnrPopup");
    if (await p.isVisible({ timeout: 800 })) {
      const btn = p.locator("button, a").first();
      if (await btn.isVisible({ timeout: 1000 })) await btn.click({ timeout: 2000 }).catch(() => {});
      else await p.evaluate((el) => el.remove()).catch(() => {});
      await page.waitForTimeout(700);
    }
  } catch { /* ignore */ }
}
const REJECTED_RE = /accessdenied|notfound|\/error\/|was rejected|Page not found/i;
function isRejected(page) {
  let u = ""; try { u = page.url(); } catch { /* ignore */ }
  return REJECTED_RE.test(u) || false;
}
async function settle(page, tag, logStep, waitMs = 6000) {
  await page.waitForTimeout(waitMs);
  await dismissPopup(page);
  await snap(page, tag).catch(() => {});
  await dumpTables(page, tag).catch(() => {});
  await dumpAnchors(page, tag).catch(() => {});
  let final = "";
  try { final = page.url(); } catch { /* ignore */ }
  logStep(tag, "url=" + final);
  return !isRejected(page);
}
// direct goto with real-site referer; falls back to in-page menu click (like a real user)
async function visit(page, url, linkText, tag, logStep) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT, referer: "https://www.gst.gov.in/" });
    let ok = await settle(page, tag, logStep);
    if (ok && url !== U.home) {
      let u = ""; try { u = page.url(); } catch { /* ignore */ }
      if (u.replace(/\/$/, "") === U.home.replace(/\/$/, "")) { ok = false; logStep(tag + "-redirected-home", "subdomain bounced to home — trying menu click"); }
    }
    if (ok) return true;
    logStep(tag + "-rejected", "direct goto rejected — trying menu click");
  } catch (e) { logStep(tag + "-goto-err", e.message); }
  // fallback: go home, then click the nav link with matching text
  try {
    await page.goto(U.home, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT });
    await page.waitForTimeout(5000);
    await dismissPopup(page);
    const clicked = await page.evaluate((lbl) => {
      const esc = lbl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exact = new RegExp("^" + esc + "$", "i");
      const contains = new RegExp(esc, "i");
      let cands = [...document.querySelectorAll("a")].filter((a) => {
        const t = (a.innerText || "").replace(/\s+/g, " ").trim();
        return exact.test(t) && a.href;
      });
      if (!cands.length) cands = [...document.querySelectorAll("a")].filter((a) => {
        const t = (a.innerText || "").replace(/\s+/g, " ").trim();
        return contains.test(t) && a.href && !/download|offline|tutorial/i.test(a.href);
      });
      if (!cands.length) return false;
      cands[0].click();
      return true;
    }, linkText);
    if (!clicked) { logStep(tag + "-nolink", "menu link not found: " + linkText); return false; }
    return await settle(page, tag + "-via-click", logStep);
  } catch (e) {
    logStep(tag + "-click-err", e.message);
    return false;
  }
}
// open Services dropdown then click an item by exact-ish text
async function clickServicesItem(page, itemText, tag, logStep) {
  try {
    await page.evaluate(() => {
      for (const t of document.querySelectorAll(".dropdown-toggle, a[role='button']")) {
        if ((t.innerText || "").trim().startsWith("Services")) { t.click(); return; }
      }
    });
    await page.waitForTimeout(2000);
    const clicked = await page.evaluate((lbl) => {
      const re = new RegExp("^" + lbl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
      const cands = [...document.querySelectorAll("a, span, li, button")].filter((el) => {
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        return re.test(t);
      });
      if (!cands.length) return false;
      const a = cands[0].closest("a") || cands[0];
      a.click();
      return true;
    }, itemText);
    if (!clicked) { logStep(tag + "-nolink", "services item not found: " + itemText); return false; }
    return await settle(page, tag, logStep);
  } catch (e) {
    logStep(tag + "-err", e.message);
    return false;
  }
}
async function findLinkBy(page, reSrc) {
  try {
    return await page.evaluate((reS) => {
      const re = new RegExp(reS, "i");
      for (const a of document.querySelectorAll("a")) {
        const t = (a.innerText || "").replace(/\s+/g, " ").trim();
        if (t && re.test(t) && a.href && !a.href.endsWith("#")) return { text: t.slice(0, 60), href: a.href };
      }
      return null;
    }, reSrc);
  } catch { return null; }
}
async function dumpTables(page, name) {
  try {
    const tables = await page.evaluate(() =>
      [...document.querySelectorAll("table")].slice(0, 12).map((tb) =>
        [...tb.querySelectorAll("tr")].slice(0, 25).map((tr) =>
          [...tr.querySelectorAll("th,td")].map((c) => c.innerText.trim().replace(/\s+/g, " ").slice(0, 60))
        )
      )
    );
    let url = "";
    try { url = page.url(); } catch { /* ignore */ }
    fs.writeFileSync(path.join(DEBUG_DIR, `last-tables-${name}.json`), JSON.stringify({ name, url, tables }, null, 1));
  } catch { /* ignore */ }
}
async function dumpAnchors(page, name) {
  try {
    const anchors = await page.evaluate(() =>
      [...document.querySelectorAll("a")]
        .map((a) => ({ text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60), href: a.href || "" }))
        .filter((a) => a.text && a.href && !a.href.endsWith("#"))
        .filter((v, i, arr) => arr.findIndex((x) => x.text === v.text && x.href === v.href) === i)
    );
    fs.writeFileSync(path.join(DEBUG_DIR, `last-anchors-${name}.json`), JSON.stringify(anchors, null, 1));
  } catch { /* ignore */ }
}
function balanceFromRows(rows) {
  for (const r of rows) {
    if (/balance/i.test(r.join(" "))) {
      for (let i = r.length - 1; i >= 0; i--) {
        const v = num(r[i]);
        if (r[i].trim() !== "" && v !== 0) return v;
      }
    }
  }
  return null;
}

async function scrapeAll(s, page, fp, autoUploadGstr1) {
  const base = {
    gstin: s.gstin, clientName: s.clientName, fp: fp || "",
    syncedAt: iso(), cashLedgerBalance: 0, creditLedgerBalance: 0,
    tdsTcsRecords: [], notices: [], gstr1Upload: null, source: "kdk-engine-live",
    returnStatuses: [],
  };

  // ---- debug trace (written to data/debug/last-scrape-trace.json) ----
  const trace = [];
  const logStep = (step, detail) => {
    let url = "";
    try { url = page.url(); } catch (e) {}
    trace.push({ step, url, detail: detail ? String(detail).slice(0, 400) : "", at: new Date().toISOString() });
  };
  const flushTrace = () => {
    try {
      ensureDebug();
      fs.writeFileSync(path.join(DEBUG_DIR, "last-scrape-trace.json"), JSON.stringify({ gstin: s.gstin, fp: fp || "", trace }, null, 2));
    } catch (e) {}
  };

  const grabRows = (minCols = 3) => page.evaluate((mc) => {
    const out = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const tds = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
      if (tds.length >= mc) out.push(tds);
    });
    return out;
  }, minCols);
  const bodyText = () => page.evaluate(() => document.body.innerText || "");
  const GSTIN_RE = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/;

  // ===== STEP 0: Home + cookie/session proof =====
  await visit(page, U.home, "Home", "home", logStep);
  try {
    const cookies = await page.context().cookies();
    logStep("cookies", cookies.map((c) => c.domain + ":" + c.name).join(", "));
  } catch (e) {}

  try {
    s.gstr1Url = s.gstr1Url || (await findLinkBy(page, "^GSTR-1$"))?.href || null;
    s.gstr2bUrl = s.gstr2bUrl || (await findLinkBy(page, "^GSTR-2B$"))?.href || null;
  } catch (e) {}

  // ===== STEP 1: Auth Dashboard (services subdomain — session is valid here) =====
  let onAuthDash = await visit(page, U.authDash, "Dashboard", "auth-dash", logStep);
  if (onAuthDash) {
    try {
      const rows = await grabRows(3);
      for (const r of rows.slice(0, 30)) {
        const joined = r.join(" ");
        if (/GSTR-?\d/i.test(joined)) {
          base.returnStatuses.push({ type: (joined.match(/GSTR-?\d+[A-Z]?/i) || [])[0] || "-", status: /filed|submitted/i.test(joined) ? "Filed" : (/not filed|pending/i.test(joined) ? "Not Filed" : "Unknown"), detail: joined.slice(0, 140) });
        }
      }
      // ledger balance table: row = ["Electronic Cash Ledger", IGST, CGST, SGST, CESS]
      for (const r of rows) {
        const label = (r[0] || "").trim();
        const total = r.slice(1).map(num).reduce((a, b) => a + b, 0);
        if (/^Electronic Cash Ledger/i.test(label)) base.cashLedgerBalance = total;
        else if (/^Electronic Credit Ledger/i.test(label)) base.creditLedgerBalance = total;
        else if (/Liability Register/i.test(label)) base.liabilityBalance = total;
      }
      const txt = await bodyText();
      base.dashboardTextSnippet = txt.slice(0, 900);
      logStep("auth-dash-balances", "cash=" + base.cashLedgerBalance + " itc=" + base.creditLedgerBalance + " liability=" + base.liabilityBalance);
    } catch (e) { logStep("auth-dash-err", e.message); }
  }

  // ===== STEP 2: Returns Dashboard (return subdomain) =====
  let onRetDash = await visit(page, U.returnsDash, "Returns Dashboard", "returns-dash", logStep);
  if (onRetDash) {
    s.gstr1Url = (await findLinkBy(page, "^GSTR-1$"))?.href || s.gstr1Url || U.gstr1Guess;
    s.gstr2bUrl = (await findLinkBy(page, "^GSTR-2B$"))?.href || U.gstr2bGuess;
    logStep("link-capture", "gstr1=" + s.gstr1Url + " gstr2b=" + s.gstr2bUrl);
    try {
      // fill File Returns form: Financial Year / Quarter / Period, then SEARCH
      const mm = parseInt((fp || "").slice(0, 2), 10);
      const yy = parseInt((fp || "").slice(2, 6), 10);
      if (mm >= 1 && mm <= 12 && yy >= 2017) {
        const fyStart = mm >= 4 ? yy : yy - 1;
        const fyLabel = fyStart + "-" + String(fyStart + 1).slice(2);
        const quarter = mm >= 10 ? "Quarter 3 (Oct - Dec)" : mm >= 7 ? "Quarter 2 (Jul - Sep)" : mm >= 4 ? "Quarter 1 (Apr - Jun)" : "Quarter 4 (Jan - Mar)";
        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const sels = page.locator("select");
        const nSel = await sels.count();
        if (nSel >= 3) {
          await sels.nth(0).selectOption({ label: fyLabel }).catch(async () => sels.nth(0).selectOption(fyLabel).catch(() => {}));
          await sels.nth(1).selectOption({ label: quarter }).catch(async () => sels.nth(1).selectOption(quarter).catch(() => {}));
          await sels.nth(2).selectOption({ label: months[mm - 1] }).catch(async () => sels.nth(2).selectOption(months[mm - 1]).catch(() => {}));
          await page.waitForTimeout(800);
          const searchBtn = page.locator("button:has-text('SEARCH'), button:has-text('Search'), input[type='submit']").first();
          if (await searchBtn.isVisible({ timeout: 3000 })) {
            await searchBtn.click({ timeout: 5000 }).catch(() => {});
            logStep("returns-search", "fy=" + fyLabel + " q=" + quarter + " m=" + months[mm - 1]);
          }
        }
        await page.waitForTimeout(6000);
        await snap(page, "returns-after-search").catch(() => {});
        await dumpTables(page, "returns-after-search");
      }
      const txt = await bodyText();
      base.returnsTextSnippet = txt.slice(0, 1200);
      // cards are divs, not tables — regex over body text
      const today = new Date();
      const todayStr = today.getFullYear() + "/" + String(today.getMonth() + 1).padStart(2, "0") + "/" + String(today.getDate()).padStart(2, "0");
      const dueStatus = (d) => {
        // d like 11/11/2026
        const p = d.split("/").map(Number);
        const due = new Date(p[2], p[1] - 1, p[0]);
        const past = due < new Date(today.getFullYear(), today.getMonth(), today.getDate());
        return { past, label: past ? "OVERDUE" : "Pending" };
      };
      const g1 = txt.match(/GSTR-1[^\n]{0,40}\n?\s*Due Date\s*-\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i);
      if (g1) { const st = dueStatus(g1[1]); base.returnStatuses.push({ type: "GSTR-1", status: (st.past ? "Not Filed — OVERDUE" : "Not Filed") + " (Due " + g1[1] + ")", dueDate: g1[1], detail: "PREPARE ONLINE/OFFLINE available" }); }
      else if (/GSTR-1\s*(File|View)\b/i.test(txt)) base.returnStatuses.push({ type: "GSTR-1", status: "Filed", dueDate: "-", detail: "" });
      const g3b = txt.match(/GSTR-3B[^\n]{0,40}\n?\s*Due Date\s*-\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i);
      if (g3b) { const st = dueStatus(g3b[1]); base.returnStatuses.push({ type: "GSTR-3B", status: (st.past ? "Not Filed — OVERDUE" : "Not Filed") + " (Due " + g3b[1] + ")", dueDate: g3b[1], detail: "PREPARE ONLINE/OFFLINE available" }); }
      if (/GSTR-2B/i.test(txt)) base.returnStatuses.push({ type: "GSTR-2B", status: "Auto-drafted Available", dueDate: "-", detail: "VIEW/DOWNLOAD on Returns Dashboard" });
      if (/GSTR-2A/i.test(txt)) base.returnStatuses.push({ type: "GSTR-2A", status: "Auto-drafted Available", dueDate: "-", detail: "VIEW/DOWNLOAD (view only)" });
      logStep("returns-cards", "status=" + base.returnStatuses.length + " | " + base.returnStatuses.map((r) => r.type + ":" + r.status).join(", "));
    } catch (e) { logStep("returns-dash-err", e.message); }
  }


  // ===== STEP 3b: ITC (Input Tax Credit) Ledger — only if auth dashboard had no ledger table =====
  try {
    if (!onAuthDash && await visit(page, U.itcLedger, "Liability Ledger", "itc-ledger", logStep)) {
      await dumpTables(page, "itc-ledger");
      const rows = await grabRows(3);
      const v = balanceFromRows(rows);
      if (v !== null) base.creditLedgerBalance = v;
      const txt = await bodyText();
      if (!v) {
        const m = txt.match(/Balance[^\n\d]{0,60}([\d,]+\.\d{2})/i);
        if (m) base.creditLedgerBalance = num(m[1]);
      }
      logStep("itc-ledger-balance", base.creditLedgerBalance);
    }
  } catch (e) { logStep("itc-ledger-err", e.message); }

  // ===== STEP 4: Notices / Intimations =====
  try {
    if (await visit(page, U.notices, "Notices / Intimation", "notices", logStep)) {
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const rows = await grabRows(3);
      const ntxt = await bodyText();
      logStep("notices-rows", "rawRows=" + rows.length + " | txt=" + ntxt.slice(0, 300));
      for (const r of rows.slice(0, 25)) {
        const joined = r.join(" ");
        if (/^(Ref|No\.|Type|Date|Sr)/i.test(r[0] || "")) continue; // header row
        base.notices.push({
          refId: r[0] || "NOTICE", type: r[1] || "Notice", description: r[2] || "",
          issueDate: r[3] || "-", dueDate: r[4] || "-", status: /respond|reply|pending/i.test(joined) ? "Pending Action" : "Viewed",
        });
      }
    }
  } catch (e) { logStep("notices-err", e.message); }

  // ===== STEP 5: GSTR-2B (TDS/TCS credit) — via Returns Dashboard card VIEW button =====
  let onGstr2b = false;
  try {
    // are we still on returns dashboard? go back if not
    let cur = ""; try { cur = page.url(); } catch { /* ignore */ }
    if (!/returns\/auth\/dashboard/i.test(cur)) {
      if (await visit(page, U.returnsDash, "Returns Dashboard", "returns-pre2b", logStep)) {
        const mm2 = parseInt((fp || "").slice(0, 2), 10), yy2 = parseInt((fp || "").slice(2, 6), 10);
        if (mm2 >= 1 && mm2 <= 12 && yy2 >= 2017) {
          const fyS = mm2 >= 4 ? yy2 : yy2 - 1;
          const fyL = fyS + "-" + String(fyS + 1).slice(2);
          const qtr = mm2 >= 10 ? "Quarter 3 (Oct - Dec)" : mm2 >= 7 ? "Quarter 2 (Jul - Sep)" : mm2 >= 4 ? "Quarter 1 (Apr - Jun)" : "Quarter 4 (Jan - Mar)";
          const mons = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
          const s2 = page.locator("select");
          if ((await s2.count()) >= 3) {
            await s2.nth(0).selectOption({ label: fyL }).catch(() => {});
            await s2.nth(1).selectOption({ label: qtr }).catch(() => {});
            await s2.nth(2).selectOption({ label: mons[mm2 - 1] }).catch(() => {});
            const sb = page.locator("button:has-text('SEARCH')").first();
            if (await sb.isVisible({ timeout: 3000 })) await sb.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(6000);
          }
        }
      }
    }
    // click VIEW inside the GSTR-2B card
    const clicked2b = await page.evaluate(() => {
      const containers = [...document.querySelectorAll("div, section, td")].filter((el) => {
        const t = el.innerText || "";
        return /GSTR-2B/i.test(t) && /VIEW/i.test(t) && t.length < 800;
      });
      if (!containers.length) return "no-card";
      containers.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      const card = containers[0];
      const btn = [...card.querySelectorAll("button, a, input")].find((b) => ((b.innerText || b.value || "") + "").trim().toUpperCase() === "VIEW");
      if (btn) { btn.click(); return "clicked"; }
      return "no-btn";
    });
    logStep("gstr2b-view-click", clicked2b);
    if (clicked2b === "clicked") {
      await page.waitForTimeout(8000);
      await snap(page, "gstr2b-statement").catch(() => {});
      await dumpTables(page, "gstr2b-statement");
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      onGstr2b = true;
    }
    if (!onGstr2b) {
      await page.waitForTimeout(5000); // spacing between subdomain hops (WAF rate)
      if (await visit(page, s.gstr2bUrl || U.gstr2bGuess, "GSTR-2B", "gstr2b-page", logStep)) {
        onGstr2b = true;
      }
    }
    if (onGstr2b) {
      // period select?
      let viewed = false;
      try {
        const sels = page.locator("select");
        const n = await sels.count();
        for (let i = 0; i < n && !viewed; i++) {
          const sel = sels.nth(i);
          if (await sel.isVisible().catch(() => false)) {
            const opts = await sel.locator("option").allInnerTexts().catch(() => []);
            const fpLabel = (fp || "").replace(/^0/, ""); // 102026 -> 10/2026 handled below
            const target = (fp || "").replace(/^(\d{2})(\d{4})$/, "$1/$2");
            if (opts.some((o) => o.trim().replace(/^0/, "") === target.replace(/^0/, "") || o.trim() === target)) {
              await sel.selectOption({ label: opts.find((o) => o.trim() === target) || target }).catch(async () => {
                await sel.selectOption(target).catch(() => {});
              });
              await page.waitForTimeout(1000);
              const btn = page.locator("button:has-text('View'), button:has-text('Download'), button:has-text('Submit')").first();
              if (await btn.isVisible({ timeout: 3000 })) {
                await btn.click({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(6000);
                viewed = true;
              }
            }
          }
        }
      } catch (e) { logStep("gstr2b-period-err", e.message); }
      logStep("gstr2b-viewed", String(viewed));
      if (viewed) { await snap(page, "gstr2b-statement").catch(() => {}); await dumpTables(page, "gstr2b-statement"); }
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const rows = await grabRows(4);
      for (const r of rows.slice(0, 40)) {
        const joined = r.join(" ");
        if (!GSTIN_RE.test(joined)) continue;
        const g = (joined.match(GSTIN_RE) || [])[0];
        const name = r.find((c) => c.length > 3 && !GSTIN_RE.test(c) && !/^[0-9,./\-\s]+$/.test(c)) || "-";
        const amounts = r.map(num).filter((v) => v !== 0);
        if (!amounts.length) continue;
        base.tdsTcsRecords.push({
          type: /TCS/i.test(joined) ? "TCS" : "TDS", ctin: g, cname: name,
          net: amounts[0] || 0, iamt: 0, camt: 0, samt: 0, totalCredit: amounts[amounts.length - 1] || 0,
          status: "Pending Action",
        });
      }
      logStep("gstr2b-records", base.tdsTcsRecords.length);
    }
  } catch (e) { logStep("gstr2b-err", e.message); }

  // ===== STEP 6: GSTR-1 auto-upload (queued JSON) =====
  if (autoUploadGstr1) {
    const store = load();
    const q = store.gstr1Queue[s.gstin + "_" + (fp || "")];
    if (q && q.status === "QUEUED") {
      try {
        const tmp = path.join(DATA_DIR, `gstr1_${s.gstin}_${Date.now()}.json`);
        fs.writeFileSync(tmp, q.jsonContent);
        if (await visit(page, s.gstr1Url || U.gstr1Guess, "GSTR-1", "gstr1-page", logStep)) {
        await page.waitForTimeout(2000);
        const fileInput = page.locator("input[type='file']").first();
        if (await fileInput.isVisible({ timeout: 8000 })) {
          await fileInput.setInputFiles(tmp);
          await page.waitForTimeout(2500);
          const submit = page.locator("button:has-text('Submit'), input[type='submit']").first();
          if (await submit.isVisible({ timeout: 5000 })) {
            await submit.click();
            await page.waitForTimeout(12000);
            const txt = await bodyText();
            const ack = txt.match(/(ACK[A-Z0-9]{6,})/i);
            q.status = "UPLOADED";
            q.uploadRefId = ack ? ack[1] : "SUBMITTED";
            q.uploadedAt = iso();
            save();
            base.gstr1Upload = { status: "UPLOADED", refId: q.uploadRefId, fileName: q.fileName, fp: fp || "", uploadedAt: q.uploadedAt, mode: "Auto-Upload (KDK Engine)" };
            logStep("gstr1-uploaded", q.uploadRefId);
          }
        } else if (page.url().indexOf("gstr1") !== -1) {
          base.gstr1Upload = { status: "PENDING", refId: "", fileName: q.fileName, error: "GSTR-1 page par file-upload input nahi mila (URL/step debug kar raha hoon)" };
          logStep("gstr1-no-file-input", "url=" + page.url());
        } else {
          base.gstr1Upload = { status: "PENDING", refId: "", fileName: q.fileName, error: "GSTR-1 page reject hua (WAF/login) — auto-upload next sync par dobara try hoga" };
          logStep("gstr1-rejected", "url=" + page.url());
        }
        }
      } catch (e) {
        base.gstr1Upload = { status: "FAILED", refId: "", fileName: q.fileName, error: e.message };
        logStep("gstr1-upload-err", e.message);
        await snap(page, "gstr1-upload-err").catch(() => {});
      }
    }
  }

  await snap(page, "scrape-done").catch(() => {});
  flushTrace();
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
