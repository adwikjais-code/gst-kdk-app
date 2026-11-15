// Simple JSON-file persistent store (clients, gstr1Queue, downloads)
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, "downloads")))
    fs.mkdirSync(path.join(DATA_DIR, "downloads"), { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ clients: {}, gstr1Queue: {}, meta: {} }, null, 2));
  }
}

let cache = null;

function load() {
  ensure();
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    } catch (e) {
      cache = { clients: {}, gstr1Queue: {}, meta: {} };
    }
    if (!cache.clients) cache.clients = {};
    if (!cache.gstr1Queue) cache.gstr1Queue = {};
    if (!cache.meta) cache.meta = {};
  }
  return cache;
}

function save() {
  ensure();
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

module.exports = { load, save, DATA_DIR };
