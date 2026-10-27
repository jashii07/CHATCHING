// Keeps the current order rows and saves them to a JSON file after every change, so edits survive
// a restart and a page reload. No database (PLAN.md Section 8). On Render the free disk resets on
// restart, so the demo simply loads again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toRows } from "./orders.js";
import { splitMessages } from "./dates.js";
import { mockParse } from "./ai.js";

const DEMO_FILE = new URL("../data/expected-orders.json", import.meta.url);
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);

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
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.rows)) throw new Error("no rows list");
      rows = saved.rows;
      source = saved.source ?? null; // files saved before 27 Oct have no source
    } catch (err) {
      log(`Warning: could not read the saved orders (${err.message}), so the demo orders are loaded.`);
    }
  }
  if (!rows) {
    rows = demoRows(menu);
    source = demoSource();
    save();
  }

  // Write to a temporary file first, then rename: a crash mid-write can't leave half a file.
  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ rows, source }, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  return {
    rows: () => rows,
    source: () => source,
    find: (id) => rows.find((row) => row.id === id) ?? null,
    replace(updated) {
      rows = rows.map((row) => (row.id === updated.id ? updated : row));
      save();
      return updated;
    },
  };
}
