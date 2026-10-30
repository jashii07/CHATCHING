// Keeps the current order rows and saves them to a JSON file after every change, so edits survive
// a restart and a page reload. No database (PLAN.md Section 8). On Render the free disk resets on
// restart, so the demo simply loads again.
// A "batch" is one read of the chats: its id goes into every invoice number (CHATCHING-{batch}-{nn}).
// New batch saves the old batch to batches/{id}.json next to the store file, so invoice links are kept.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toRows } from "./orders.js";
import { splitMessages } from "./dates.js";
import { mockParse } from "./ai.js";

const DEMO_FILE = new URL("../data/expected-orders.json", import.meta.url);
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);
const BATCH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// 8 random capital letters or digits, e.g. "K3F9Q2ZA" (36^8 = 2.8 trillion: a repeat is very unlikely,
// and PayPal refuses a repeated invoice number anyway).
export const newBatchId = () => Array.from({ length: 8 }, () => BATCH_CHARS[randomInt(BATCH_CHARS.length)]).join("");

// The demo's rows: Gemini's real saved reply (mock mode, src/ai.js) -> toRows(). Used on first start and
// if the saved orders file is broken. (expected-orders.json stays the answer key the reply is scored against.)
export function demoRows(menu) {
  return toRows(mockParse(), menu);
}

// The chats the current rows came from, so the page can say "15 messages read" and refill the chat box.
export function demoSource() {
  const { chatDate } = JSON.parse(readFileSync(DEMO_FILE, "utf8"));
  const text = readFileSync(DEMO_CHATS, "utf8");
  return { text, chatDate, messages: splitMessages(text, chatDate).length };
}

export function createStore({ file, menu, log = console.log }) {
  let rows = null;
  let source = null;
  let batch = null;
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.rows)) throw new Error("no rows list");
      rows = saved.rows;
      source = saved.source ?? null; // files saved before 27 Oct have no source
      batch = /^[A-Z0-9]{8}$/.test(saved.batch) ? saved.batch : null; // files saved before Step 5 have none
    } catch (err) {
      log(`Warning: could not read the saved orders (${err.message}), so the demo orders are loaded.`);
    }
  }
  if (!rows) {
    rows = demoRows(menu);
    source = demoSource();
  }
  if (!batch || !existsSync(file)) {
    batch ??= newBatchId();
    save();
  }

  function save() {
    writeJson(file, { batch, rows, source });
  }

  // Write to a temporary file first, then rename: a crash mid-write can't leave half a file.
  function writeJson(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  return {
    rows: () => rows,
    source: () => source,
    batch: () => batch,
    hasInvoices: () => rows.some((row) => row.invoiceId),
    find: (id) => rows.find((row) => row.id === id) ?? null,
    replace(updated) {
      rows = rows.map((row) => (row.id === updated.id ? updated : row));
      save();
      return updated;
    },
    // A changed list of rows (an item added or removed in the drawer): same batch, same chats, saved once.
    setRows(newRows) {
      rows = newRows;
      save();
    },
    // Several rows at once (one buyer's invoice), saved once.
    replaceMany(updated) {
      const byId = new Map(updated.map((row) => [row.id, row]));
      rows = rows.map((row) => byId.get(row.id) ?? row);
      save();
    },
    // A new parse replaces every row, remembers the chats they came from, and starts a new batch id.
    // (The route only allows this while nothing is invoiced.)
    setAll(newRows, newSource) {
      rows = newRows;
      source = newSource;
      batch = newBatchId();
      save();
    },
    // New batch: the current batch is saved to batches/{id}.json, then the table starts empty.
    newBatch() {
      const archive = join(dirname(file), "batches", `${batch}.json`);
      writeJson(archive, { batch, savedAt: new Date().toISOString(), rows, source });
      rows = [];
      source = null;
      batch = newBatchId();
      save();
      return archive;
    },
    // Reset demo: an empty table, so the demo can start over. Sent invoices are first saved like a
    // New batch (their links are kept); nothing else is kept. PayPal is never touched.
    reset() {
      if (rows.some((row) => row.invoiceId)) return this.newBatch();
      rows = [];
      source = null;
      batch = newBatchId();
      save();
      return null;
    },
  };
}
