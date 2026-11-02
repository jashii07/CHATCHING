// "Open on my phone" (device pairing): a seller reads chats on the laptop and scans at pickup on the phone, and
// a table belongs to one browser's cookie. A one-time link in a QR lets the phone pick up that same cookie.
// The link is https://site/pair#<code>. The part after # is never sent to a server by a browser, so the code
// stays out of every log; public/pair.js POSTs it. Like a coat-check ticket that works once: the code is
// random (128 bits), lasts 10 minutes, and is kept only as a SHA-256 hash, in memory. A restart forgets every
// code, which is fine: a restart empties the free server's tables too.
import { createHash, randomBytes } from "node:crypto";
import qrcode from "qrcode-generator";
import { isPairCode } from "../public/invoice-qr.js";
import { MAX_VISITORS } from "./visitors.js";

export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_EXPIRED = "This link has expired. Make a new one on your laptop.";
export const PAIR_REPLACE = "This phone already has orders. Replace them with the laptop's orders?";

const hash = (code) => createHash("sha256").update(code).digest("hex");

// codes: hash -> { visitorId, expires }, oldest first (a test passes its own Map to look inside).
export function createPairing({ now = Date.now, ttlMs = PAIR_TTL_MS, maxCodes = MAX_VISITORS, codes = new Map() } = {}) {
  function tidy() {
    for (const [key, { expires }] of codes) {
      if (now() >= expires || codes.size > maxCodes) codes.delete(key);
    }
  }

  return {
    // -> the code. One live link per visitor: a new QR makes the old one useless.
    create(visitorId) {
      for (const [key, entry] of codes) {
        if (entry.visitorId === visitorId) codes.delete(key);
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(hash(code), { visitorId, expires: now() + ttlMs });
      tidy();
      return code;
    },

    // -> whose table this code opens, or null. It leaves the code alone: the phone may still have a question to ask.
    peek(code) {
      if (!isPairCode(code)) return null;
      const entry = codes.get(hash(code));
      return entry && now() < entry.expires ? entry.visitorId : null;
    },

    // -> the visitor id, or null. Deleted before anything else, so a code can never work twice.
    redeem(code) {
      if (!isPairCode(code)) return null;
      const key = hash(code);
      const entry = codes.get(key);
      codes.delete(key);
      return entry && now() < entry.expires ? entry.visitorId : null;
    },
  };
}

function makeQr(text) {
  const qr = qrcode(0, "M"); // 0: the smallest size that fits; M: still reads with some glare or a smudge
  qr.addData(text, "Byte");
  qr.make();
  return qr;
}

// The QR's dark and light squares, for checking what a phone will read.
export function qrMatrix(text) {
  const qr = makeQr(text);
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (__, col) => qr.isDark(row, col)));
}

// The QR as an image the page can show. 24 px of white around it: scanners need that quiet edge.
export const pairQr = (text) => makeQr(text).createDataURL(6, 24);
