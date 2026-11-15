// ============================================================
// KDK GST ENGINE — server entry
// Static frontend + /api/kdk/* + /downloads/*  (one process,
// same-origin friendly: frontend auto-detects engine on port
// 3000 / 7860 without any setup)
// ============================================================
const path = require("path");
const express = require("express");
const cors = require("cors");
const demo = require("./src/demo");
const { DATA_DIR } = require("./src/store");

const MODE = (process.env.MODE || "demo").toLowerCase(); // "demo" | "live"
const engine = MODE === "live" ? require("./src/gstportal") : demo;

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()) : true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);
app.use(express.json({ limit: "25mb" })); // GSTR-1 JSONs can be big

// --- static: 1-click downloads + debug screenshots + frontend (local preview) ---
app.use("/downloads", express.static(path.join(DATA_DIR, "downloads"), { maxAge: "1h" }));
app.use("/debug", express.static(path.join(DATA_DIR, "debug"), { maxAge: "5m" }));
const WEB_DIR = path.join(__dirname, "..");
app.use(express.static(WEB_DIR));

// --- health / status ---
app.get("/", (req, res) => {
  res.json({ ok: true, name: "KDK GST Engine", mode: MODE, time: new Date().toISOString() });
});
app.get("/api/kdk/status", (req, res) => {
  try { res.json(engine.status()); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// --- results (frontend merges this into local store) ---
app.get("/api/kdk/results", (req, res) => {
  try { res.json(engine.results()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- login flow ---
app.post("/api/kdk/init-login", async (req, res) => {
  try {
    res.json(await engine.initLogin(req.body || {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/kdk/submit-sync", async (req, res) => {
  try {
    res.json(await engine.submitSync(req.body || {}));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/kdk/queue-gstr1", (req, res) => {
  try { res.json(engine.queueGstr1(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/kdk/download-item", async (req, res) => {
  try { res.json(await engine.downloadItem(req.body || {})); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message });
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ KDK GST Engine running — mode: ${MODE} — http://0.0.0.0:${PORT}`);
});
