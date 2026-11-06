// The buyer's private "Your order" link (6 Nov): https://site/order#<token>, one per sent invoice.
// Like a parcel tracking link: whoever has it sees that one order, nothing else, and needs no login.
//
// Two needs pull apart here. The link must be stored only as a hash (a stolen file must not open any order),
// but the seller must be able to copy it again later: after a reload, or on their paired phone. So the token
// is never stored at all. It is a keyed hash (HMAC-SHA256) of the visitor, the batch and the invoice, made
// with a 256-bit random key that only the server holds. The server can rebuild it whenever the seller copies
// it; the files hold only its SHA-256 hash. Without the key nobody can work out a token, and from a hash
// nobody can work back to one.
//
// One small file, <visitors folder>/order-links.json: { key, links: { hash: visitorId } }. links is how a
// buyer's link finds the right table (the token has no visitor id in it, and the page shows none). The
// buyer's rows hold the same hash, so a link only works while those rows are the seller's current table:
// Reset demo and New batch end it. The file is written only once a first invoice is sent. Its name doesn't
// look like a visitor's file, so the cleanup in src/visitors.js leaves it alone. On Render a restart empties
// the disk, key included, and with it every table: old links then get the same "doesn't work" words.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isVisitorId } from "./visitors.js";

export const ORDER_LINK_GONE = "This order link doesn't work any more. Please ask the seller for a new one.";
export const MAX_LINKS = 5000; // about 500 tables x 10 buyers; past it, the oldest links go first

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes as base64url, no padding
const KEY = /^[0-9a-f]{64}$/;
export const isOrderToken = (value) => typeof value === "string" && TOKEN.test(value);
export const hashOf = (token) => createHash("sha256").update(token).digest("hex");

export function createOrderLinks({ dir, log = console.log }) {
  const file = join(dir, "order-links.json");
  let key = null;
  let links = null; // Map hash -> visitor id, oldest first

  function load() {
    if (links) return;
    links = new Map();
    if (!existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (KEY.test(saved?.key)) key = saved.key;
      for (const [hash, id] of Object.entries(saved?.links ?? {})) if (/^[0-9a-f]{64}$/.test(hash) && isVisitorId(id)) links.set(hash, id);
    } catch (err) {
      log(`Warning: could not read the order links (${err.message}), so earlier buyer links stop working.`);
    }
  }

  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ key, links: Object.fromEntries(links) }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file); // a crash mid-write can't leave half a file
  }

  return {
    // -> the token for one sent invoice. The same inputs always give the same token.
    tokenFor(visitorId, batch, invoiceId) {
      load();
      if (!key) {
        key = randomBytes(32).toString("hex");
        save();
      }
      return createHmac("sha256", Buffer.from(key, "hex")).update(`${visitorId}\n${batch}\n${invoiceId}`).digest("base64url");
    },

    // The link can now find its table. Written before the rows get the hash, so a crash in between leaves a
    // link that finds no rows (safe), never rows whose link can't be found.
    register(hash, visitorId) {
      load();
      if (links.get(hash) === visitorId) return;
      links.delete(hash);
      links.set(hash, visitorId);
      for (const old of links.keys()) {
        if (links.size <= MAX_LINKS) break;
        links.delete(old);
      }
      save();
    },

    // A buyer's token -> { visitorId, hash }, or null. Nothing here says how close a wrong token was.
    find(token) {
      if (!isOrderToken(token)) return null;
      load();
      const hash = hashOf(token);
      const visitorId = links.get(hash);
      return visitorId ? { visitorId, hash } : null;
    },
  };
}
