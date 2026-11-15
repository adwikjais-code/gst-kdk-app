// ============================================================
// KDK ENGINE — DEMO MODE (Simulated GST Portal)
// Full KDK-style flow: ID+password auto-fill → Captcha → SMS OTP
// → data sync (TDS/TCS, Notices, Ledgers) → GSTR-1 auto-upload
// → 1-click downloads. Zero external dependencies, 100% offline.
// ============================================================
const crypto = require("crypto");
const { load, save } = require("./store");
const { captchaImage, smsOtpImage, randomCode } = require("./captcha");
const { noticePdf, gstr2bJson, gstr3bPdf, gstr1Pdf } = require("./files");

const SESSIONS = new Map();
const BASE_TTL_MS = 30 * 60 * 1000; // 30 min
const KEEPALIVE_TTL_MS = 12 * 60 * 60 * 1000; // 12 h (downloads)

function now() { return Date.now(); }
function iso(d = new Date()) { return d.toISOString(); }

// ---------- deterministic pseudo-random per (gstin + fp) ----------
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- realistic sync data generator ----------
function buildSyncData(gstin, clientName, fp, autoUploadGstr1) {
  const rnd = mulberry32(seedFrom(gstin + "|" + (fp || "")));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (min, max) => Math.floor(min + rnd() * (max - min + 1));

  // TDS/TCS records (GSTR-2B RCM)
  const vendors = [
    { type: "TCS (Sec 52)", ctin: "27AAJCE9603R1Z5", cname: "ETSY IRELAND UC" },
    { type: "TCS (Sec 52)", ctin: "29AABCF6721Q1Z7", cname: "FLIPKART INTERNET PVT LTD" },
    { type: "TDS (Sec 51)", ctin: "29AAJCA4793R1Z7", cname: "AMAZON (INDIA) RETAIL" },
    { type: "TDS (Sec 194J)", ctin: "27AAGIC2130E1Z5", cname: "GOOGLE LLC IN" },
  ];
  const count = int(2, 3);
  const tdsTcsRecords = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const v = pick(vendors);
    if (used.has(v.ctin)) continue;
    used.add(v.ctin);
    const net = int(15, 480) * 1000;
    const rate = v.type.includes("52") ? 0.005 : v.type.includes("194J") ? 0.1 : 0.01;
    const credit = Math.round(net * rate * 100) / 100;
    tdsTcsRecords.push({
      type: v.type, ctin: v.ctin, cname: v.cname, net,
      iamt: Math.round(credit * 100) / 100, camt: 0, samt: 0,
      totalCredit: credit, status: pick(["Pending Action", "Pending Action", "Credit Taken"]),
    });
  }

  // Notices
  const noticeTypes = [
    { type: "ASMT-10", description: "Intimation u/s 45(3) — summary of return & ITC discrepancy" },
    { type: "DRC-01", description: "Demand notice u/s 61 — tax/interest payable" },
    { type: "ADT-01", description: "Additional demand u/s 62 — verification of ITC" },
    { type: "DCIT-07", description: "Scrutiny of returns — supporting documents required" },
  ];
  const nCount = rnd() < 0.75 ? int(1, 2) : 0;
  const notices = [];
  const today = new Date();
  for (let i = 0; i < nCount; i++) {
    const nt = pick(noticeTypes);
    const issue = new Date(today.getTime() - int(2, 20) * 86400000);
    const due = new Date(issue.getTime() + int(15, 45) * 86400000);
    const fmt = (d) => String(d.getDate()).padStart(2, "0") + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + d.getFullYear();
    notices.push({
      refId: nt.type.slice(0, 2) + String(gstin.slice(0, 2)) + String(int(100000, 999999)) + "K1",
      type: nt.type + " Notice",
      description: nt.description,
      issueDate: fmt(issue),
      dueDate: fmt(due),
      status: "Pending Action",
    });
  }

  // Ledgers + taxable value
  const data = {
    gstin,
    clientName,
    fp: fp || "",
    syncedAt: iso(),
    cashLedgerBalance: int(0, 12) * 100 + int(0, 99),
    creditLedgerBalance: int(0, 42) * 1000 + int(0, 999),
    taxableValue: int(85, 720) * 1000,
    tdsTcsRecords,
    notices,
    gstr1Upload: null,
    source: "kdk-engine-demo",
  };

  // GSTR-1 auto-upload (if queued in engine store)
  if (autoUploadGstr1) {
    const store = load();
    const qKey = gstin + "_" + (fp || "");
    const q = store.gstr1Queue[qKey];
    if (q && q.status === "QUEUED") {
      const ackRef = "ACK" + (fp || "").replace(/-/g, "") + String(int(100000, 999999));
      q.status = "UPLOADED";
      q.uploadRefId = ackRef;
      q.uploadedAt = iso();
      save();
      data.gstr1Upload = {
        status: "UPLOADED",
        refId: ackRef,
        fileName: q.fileName,
        fp: fp || "",
        uploadedAt: q.uploadedAt,
        mode: "Auto-Upload (KDK Engine)",
      };
    }
  }
  return data;
}

// ---------- session helpers ----------
function sessionTtl(s) { return (s.keepAlive ? KEEPALIVE_TTL_MS : BASE_TTL_MS); }

function isAlive(s) {
  return s && now() - Math.max(s.createdAt, s.lastUsed) < sessionTtl(s);
}

setInterval(() => {
  for (const [id, s] of SESSIONS) if (!isAlive(s)) SESSIONS.delete(id);
}, 5 * 60 * 1000).unref();

// ---------- API ----------
async function initLogin({ gstin, username, password, clientName, fp }) {
  if (!gstin || !username || !password) {
    return { ok: false, error: "Portal ID / Password missing — client me set nahi hai." };
  }
  const id = crypto.randomUUID();
  const code = randomCode();
  const mobile = "9" + String(seedFrom(gstin) % 900000000 + 100000000).slice(1, 4) + "•••" + String(seedFrom(gstin + "x") % 9000 + 1000);
  SESSIONS.set(id, {
    id, gstin, username, password, clientName: clientName || gstin, fp: fp || "",
    mobile, stage: "captcha", captchaCode: code, otp: null,
    createdAt: now(), lastUsed: now(), keepAlive: false,
  });
  return { ok: true, sessionId: id, captchaImage: captchaImage(code) };
}

async function submitSync({ sessionId, captcha, fp, autoUploadGstr1, keepAliveForDownloads }) {
  const s = SESSIONS.get(sessionId);
  if (!s || !isAlive(s)) {
    SESSIONS.delete(sessionId);
    return { ok: false, needRelogin: true, error: "Session expire — dobara login karein." };
  }
  s.lastUsed = now();
  if (keepAliveForDownloads) s.keepAlive = true;
  const code = String(captcha || "").trim();

  if (s.stage === "captcha") {
    if (code !== s.captchaCode) {
      const next = randomCode();
      s.captchaCode = next;
      return {
        ok: false,
        error: "❌ Captcha galat hai! Naya captcha generate ho gaya — dobara dalein:",
        captchaImage: captchaImage(next),
      };
    }
    // Captcha verified → portal "sends" OTP to registered mobile
    s.stage = "otp";
    s.otp = randomCode();
    return {
      ok: false, // not finished yet — frontend shows next step with same input box
      error: "✅ Captcha verified! Ab <b>SMS par aaya 6-digit OTP</b> same box me dalein (6th digit par auto-sync):",
      captchaImage: smsOtpImage(s.otp, s.mobile),
    };
  }

  if (s.stage === "otp") {
    if (code !== s.otp) {
      const next = randomCode();
      s.otp = next;
      return {
        ok: false,
        error: "❌ OTP galat! Naya OTP SMS par bhej diya gaya hai:",
        captchaImage: smsOtpImage(next, s.mobile),
      };
    }
    s.stage = "logged_in";
    // simulate background fetch time
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 700));
    const data = buildSyncData(s.gstin, s.clientName, fp || s.fp, !!autoUploadGstr1);
    const store = load();
    store.clients[s.gstin] = data;
    save();
    return { ok: true, sessionId, data };
  }

  // already logged in — just re-sync
  const data = buildSyncData(s.gstin, s.clientName, fp || s.fp, !!autoUploadGstr1);
  const store = load();
  store.clients[s.gstin] = data;
  save();
  return { ok: true, sessionId, data };
}

async function downloadItem({ sessionId, gstin, itemType, refId, fp }) {
  const s = SESSIONS.get(sessionId);
  const alive = s && isAlive(s) && s.stage === "logged_in";
  if (!alive) {
    return { ok: false, needRelogin: true, error: "Portal session active nahi — Captcha/OTP dalte hi download ho jayega." };
  }
  s.lastUsed = now();
  const store = load();
  const cd = store.clients[gstin] || { clientName: s.clientName, gstin, fp: fp || s.fp, tdsTcsRecords: [], notices: [], cashLedgerBalance: 0, creditLedgerBalance: 0, gstr1Upload: null };
  const period = fp || s.fp || cd.fp || "";

  try {
    if (itemType === "NOTICE") {
      const notice = (cd.notices || []).find((n) => n.refId === refId) ||
        { refId: refId || "NOTICE", type: "Notice", description: "Notice copy", issueDate: "-", dueDate: "-", status: "Pending Action" };
      return { ok: true, ...noticePdf(cd.clientName, gstin, notice, period) };
    }
    if (itemType === "GSTR2B_JSON") {
      return { ok: true, ...gstr2bJson(cd.clientName, gstin, cd.tdsTcsRecords, period) };
    }
    if (itemType === "GSTR3B_SUMMARY") {
      return { ok: true, ...gstr3bPdf(cd.clientName, gstin, cd, period) };
    }
    if (itemType === "GSTR1_SUMMARY") {
      const qKey = gstin + "_" + period;
      return { ok: true, ...gstr1Pdf(cd.clientName, gstin, cd, period, store.gstr1Queue[qKey] || null) };
    }
    return { ok: false, error: "Unknown item type: " + itemType };
  } catch (e) {
    return { ok: false, error: "Download failed: " + e.message };
  }
}

function queueGstr1({ gstin, fp, fileName, jsonContent }) {
  const store = load();
  const key = gstin + "_" + (fp || "");
  const existed = store.gstr1Queue[key];
  store.gstr1Queue[key] = {
    gstin, fp: fp || "", fileName: fileName || `GSTR1_${gstin}_${fp}.json`,
    jsonContent: String(jsonContent || ""), status: "QUEUED",
    queuedAt: iso(), updatedAt: iso(),
    ...(existed && existed.status === "UPLOADED" ? {} : {}),
  };
  save();
  return { ok: true, queued: true, key };
}

function status() {
  let active = 0;
  for (const s of SESSIONS.values()) if (isAlive(s) && s.stage === "logged_in") active++;
  return { ok: true, mode: "demo", name: "KDK GST Engine (Simulated Portal)", activeSessions: active, time: iso() };
}

function results() {
  const store = load();
  return { ok: true, mode: "demo", store: { clients: store.clients, gstr1Queue: store.gstr1Queue } };
}

function clients() { return { ok: true, mode: "demo", clients: [] }; }
module.exports = { initLogin, submitSync, downloadItem, queueGstr1, status, results, clients, SESSIONS };
