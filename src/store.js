// One visitor's order rows, saved to their own JSON file after every change, so edits survive a restart and
// a page reload. No database (PLAN.md Section 8). A visitor with no file has an empty table, and no file is
// written until there is something to save (src/visitors.js has the why). On Render the free disk resets on
// restart, so every table starts empty again; invoices stay safe at PayPal.
// A "batch" is one read of the chats: its id goes into every invoice number (CHATCHING-{batch}-{nn}).
// New batch keeps the old batch inside the visitor's file, so invoice links are kept and the cleanup leaves
// nothing behind.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toRows } from "./orders.js";
import { splitMessages } from "./dates.js";
import { mockParse } from "./ai.js";

const DEMO_FILE = new URL("../data/expected-orders.json", import.meta.url);
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);
const BATCH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BATCH_LENGTH = 12;
const MAX_BATCHES = 20; // per visitor, so one file can't grow for ever; PayPal keeps every invoice anyway

// 12 random capital letters or digits, e.g. "K3F9Q2ZA7L1X" (36^12 = 4.7 million million million). Every
// visitor's invoices share one PayPal account, so a batch id must never repeat across visitors. 12 is the
// most that fits: the invoice number is then exactly PayPal's 25 characters.
export const newBatchId = () => Array.from({ length: BATCH_LENGTH }, () => BATCH_CHARS[randomInt(BATCH_CHARS.length)]).join("");

// The demo's rows: Gemini's real saved reply (mock mode, src/ai.js) -> toRows(). Used by the smoke test and
// the test visitor. (expected-orders.json stays the answer key the reply is scored against.)
export function demoRows(menu) {
  return toRows(mockParse(), menu);
}

// The chats the current rows came from, so the page can say "15 messages read" and refill the chat box.
export function demoSource() {
  const { chatDate } = JSON.parse(readFileSync(DEMO_FILE, "utf8"));
  const text = readFileSync(DEMO_CHATS, "utf8");
  return { text, chatDate, messages: splitMessages(text, chatDate).length };
}

// onNewFile: called once, right after this visitor's file is first written (the cleanup runs then).
export function createStore({ file, log = console.log, onNewFile = () => {} }) {
  let rows = [];
  let source = null;
  let batch = null;
  let batches = []; // this visitor's earlier batches, oldest first: rows + invoice links
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.rows)) throw new Error("no rows list");
      rows = saved.rows;
      source = saved.source ?? null;
      batch = /^[A-Z0-9]{12}$/.test(saved.batch) ? saved.batch : null;
      batches = Array.isArray(saved.batches) ? saved.batches : [];
    } catch (err) {
      log(`Warning: could not read a visitor's saved orders (${err.message}), so their table starts empty.`);
    }
  }
  batch ??= newBatchId();

  function save() {
    const isNew = !existsSync(file);
    if (isNew && !rows.length && !batches.length) return;
    // Write to a temporary file first, then rename: a crash mid-write can't leave half a file.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ batch, rows, source, batches }, null, 2));
    renameSync(`${file}.tmp`, file);
    if (isNew) onNewFile();
  }

  // The rows and invoice links stay in this visitor's file; the table starts empty.
  function keepBatch() {
    if (rows.length) batches = [...batches, { batch, savedAt: new Date().toISOString(), rows, source }].slice(-MAX_BATCHES);
  }

  function emptyTable() {
    rows = [];
    source = null;
    batch = newBatchId();
    save();
  }

  return {
    rows: () => rows,
    source: () => source,
    batch: () => batch,
    batches: () => batches,
    hasInvoices: () => rows.some((row) => row.invoiceId || row.sendUnknown), // a send with no answer may have made one
    find: (id) => rows.find((row) => row.id === id) ?? null,
    // A page load: the visitor is still here, so the cleanup must not count their table as old.
    touch() {
      if (!existsSync(file)) return;
      const today = new Date();
      utimesSync(file, today, today);
    },
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
    newBatch() {
      keepBatch();
      emptyTable();
    },
    // Reset demo: an empty table, so the demo can start over. Sent invoices are first kept like a New
    // batch (their links stay); nothing else is kept. PayPal is never touched.
    reset() {
      if (rows.some((row) => row.invoiceId)) keepBatch();
      // "Start the demo over": what is saved stays saved, but raises no "already has an invoice" check again.
      batches = batches.map((saved) => ({ ...saved, fromReset: true }));
      emptyTable();
    },
  };
}
