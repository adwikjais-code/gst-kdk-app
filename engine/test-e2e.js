// E2E test: simulates the frontend KDK flow against the engine
const BASE = "http://localhost:7860";

function codeFromSvg(dataUrl) {
  const svg = Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
  // captcha: digits are individual <text ...>N</text>; sms: OTP in a tspan
  let m = svg.match(/letter-spacing="6">(\d{6})<\/tspan>/); // sms otp
  if (m) return m[1];
  m = [...svg.matchAll(/letter-spacing="1">(\d)<\/text>/g)].map((x) => x[1]).join(""); // captcha digits
  return m;
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond, extra = "") => {
    console.log((cond ? "✅ PASS" : "❌ FAIL") + " — " + name + (extra ? "  [" + extra + "]" : ""));
    cond ? pass++ : fail++;
  };
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };

  // 1. status
  const st = await (await fetch(BASE + "/api/kdk/status")).json();
  check("status ok", st.ok === true && st.mode === "demo", JSON.stringify(st));

  // 2. queue a GSTR-1 file BEFORE sync (to test auto-upload)
  const q = await post("/api/kdk/queue-gstr1", { gstin: "09GGLPA9149F1Z2", fp: "1026", fileName: "GSTR1_09GGLPA9149F1Z2_1026.json", jsonContent: '{"header":{"gstin":"09GGLPA9149F1Z2","fp":"1026"},"data":{"b2c":[],"b2b":[]}}' });
  check("queue-gstr1", q.ok === true && q.queued === true);

  // 3. init-login
  const il = await post("/api/kdk/init-login", { gstin: "09GGLPA9149F1Z2", username: "etsy_up_01", password: "Zara@1234", clientName: "Sample Etsy Client", fp: "1026", demoMode: false });
  check("init-login ok + captcha image", il.ok === true && !!il.sessionId && (il.captchaImage || "").startsWith("data:image/"), "sessionId=" + (il.sessionId || "").slice(0, 8));
  const captcha = codeFromSvg(il.captchaImage);
  check("captcha code readable (6 digits)", /^\d{6}$/.test(captcha || ""), "code=" + captcha);

  // 4. wrong captcha → should fail + new captcha
  const wrong = await post("/api/kdk/submit-sync", { sessionId: il.sessionId, captcha: "000000", fp: "1026", autoUploadGstr1: true, keepAliveForDownloads: true });
  check("wrong captcha rejected + fresh captcha", wrong.ok === false && !!wrong.captchaImage);

  // 5. correct captcha → OTP stage
  const cap2 = codeFromSvg(wrong.captchaImage);
  const c1 = await post("/api/kdk/submit-sync", { sessionId: il.sessionId, captcha: cap2, fp: "1026", autoUploadGstr1: true, keepAliveForDownloads: true });
  check("captcha verified → OTP step (SMS image)", c1.ok === false && (c1.captchaImage || "").startsWith("data:image/") && /OTP/i.test(c1.error || ""));
  const otp = codeFromSvg(c1.captchaImage);
  check("OTP readable (6 digits)", /^\d{6}$/.test(otp || ""), "otp=" + otp);

  // 6. OTP → full sync
  const c2 = await post("/api/kdk/submit-sync", { sessionId: il.sessionId, captcha: otp, fp: "1026", autoUploadGstr1: true, keepAliveForDownloads: true });
  check("OTP → login + sync complete", c2.ok === true && !!c2.data, "gstin=" + (c2.data && c2.data.gstin));
  if (c2.data) {
    const d = c2.data;
    check("sync data: TDS/TCS records", Array.isArray(d.tdsTcsRecords) && d.tdsTcsRecords.length >= 1, d.tdsTcsRecords.length + " records");
    check("sync data: ledgers present", typeof d.cashLedgerBalance === "number" && typeof d.creditLedgerBalance === "number");
    check("GSTR-1 auto-uploaded (was queued)", d.gstr1Upload && d.gstr1Upload.status === "UPLOADED", "ref=" + (d.gstr1Upload && d.gstr1Upload.refId));
    const notice = (d.notices || [])[0] || {};
    // 7. downloads
    const dl = await post("/api/kdk/download-item", { sessionId: il.sessionId, gstin: d.gstin, itemType: "NOTICE", refId: notice.refId || "NOTICE", fp: "1026" });
    check("download NOTICE pdf", dl.ok === true && !!dl.downloadUrl, dl.fileName);
    if (dl.ok) {
      const fr = await fetch(BASE + dl.downloadUrl);
      const buf = Buffer.from(await fr.arrayBuffer());
      check("  ...file actually served (PDF header)", fr.status === 200 && buf.slice(0, 5).toString() === "%PDF-");
    }
    const dl2 = await post("/api/kdk/download-item", { sessionId: il.sessionId, gstin: d.gstin, itemType: "GSTR2B_JSON", fp: "1026" });
    check("download GSTR-2B json", dl2.ok === true, dl2.fileName);
    const dl3 = await post("/api/kdk/download-item", { sessionId: il.sessionId, gstin: d.gstin, itemType: "GSTR3B_SUMMARY", fp: "1026" });
    check("download GSTR-3B pdf", dl3.ok === true, dl3.fileName);
    const dl4 = await post("/api/kdk/download-item", { sessionId: il.sessionId, gstin: d.gstin, itemType: "GSTR1_SUMMARY", fp: "1026" });
    check("download GSTR-1 pdf", dl4.ok === true, dl4.fileName);
  }

  // 8. results endpoint
  const res = await (await fetch(BASE + "/api/kdk/results")).json();
  check("results store has client", res.ok === true && !!res.store.clients["09GGLPA9149F1Z2"]);
  check("results store queue UPLOADED", res.store.gstr1Queue["09GGLPA9149F1Z2_1026"] && res.store.gstr1Queue["09GGLPA9149F1Z2_1026"].status === "UPLOADED");

  // 9. expired/unknown session → needRelogin
  const bad = await post("/api/kdk/download-item", { sessionId: "nonexistent", gstin: "09GGLPA9149F1Z2", itemType: "NOTICE", refId: "X", fp: "1026" });
  check("unknown session → needRelogin", bad.ok === false && bad.needRelogin === true);

  // 10. frontend still served
  const html = await (await fetch(BASE + "/")).text();
  check("frontend served (title)", html.includes("GST Client & Filing Tracker"));

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });
