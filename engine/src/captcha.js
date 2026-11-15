// Server-side captcha / OTP image generation (SVG → base64 data URL)
// Stage 1: GST-portal style distorted-digit captcha
// Stage 2: simulated SMS notification showing the 6-digit OTP

const W = 240;
const H = 72;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// GST-portal style captcha: 6 digits, per-digit rotation/skew, noise lines
function captchaImage(code) {
  const chars = String(code).split("");
  const n = chars.length;
  const startX = 30;
  const gap = (W - 60) / Math.max(n - 1, 1);
  let digits = "";
  let lines = "";

  for (let i = 0; i < 6; i++) {
    lines += `<line x1="${rand(0, W)}" y1="${rand(0, H)}" x2="${rand(0, W)}" y2="${rand(0, H)}" stroke="rgba(100,116,139,0.5)" stroke-width="1.5"/>`;
  }
  for (let i = 0; i < n; i++) {
    const x = startX + i * gap;
    const y = 48 + rand(-6, 6);
    const rot = rand(-28, 28);
    const skew = rand(-10, 10);
    const fill = ["#0f172a", "#1e293b", "#334155", "#7c3aed", "#0f766e"][i % 5];
    digits += `<text x="${x}" y="${y}" font-family="Courier New, monospace" font-size="${rand(30, 38)}" font-weight="bold" fill="${fill}" transform="rotate(${rot} ${x} ${y}) skewX(${skew})" letter-spacing="1">${escapeXml(chars[i])}</text>`;
  }
  // dots
  let dots = "";
  for (let i = 0; i < 22; i++) {
    dots += `<circle cx="${rand(0, W)}" cy="${rand(0, H)}" r="${rand(0.8, 2)}" fill="rgba(15,23,42,0.35)"/>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="10" fill="#eef2f7"/>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="9" fill="none" stroke="#94a3b8" stroke-width="1.5"/>` +
    lines + dots + digits +
    `<text x="8" y="14" font-family="Arial" font-size="8" font-weight="bold" fill="#64748b">GST PORTAL SECURE CODE</text>` +
    `</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

// Simulated SMS with OTP — exactly what user would get on their phone
function smsOtpImage(otp, mobile) {
  const num = mobile || "98••••1234";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="132" viewBox="0 0 320 132">` +
    `<rect width="320" height="132" rx="14" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>` +
    `<rect x="14" y="12" width="292" height="26" rx="8" fill="#e0f2fe"/>` +
    `<text x="26" y="29" font-family="Arial" font-size="12" font-weight="bold" fill="#0369a1">📱 SMS • GSTN • ${escapeXml(num)}</text>` +
    `<rect x="14" y="46" width="230" height="70" rx="10" fill="#ffffff" stroke="#e2e8f0"/>` +
    `<text x="28" y="70" font-family="Arial" font-size="12" fill="#0f172a">Aapka GST Portal OTP <tspan font-size="20" font-weight="bold" fill="#059669" letter-spacing="6">${escapeXml(otp)}</tspan> hai.</text>` +
    `<text x="28" y="92" font-family="Arial" font-size="10" fill="#64748b">Ise kisi se share na karein. Koi bhi GSTN employee</text>` +
    `<text x="28" y="106" font-family="Arial" font-size="10" fill="#64748b">is OTP ka demand nahi karta.</text>` +
    `</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = { captchaImage, smsOtpImage, randomCode };
