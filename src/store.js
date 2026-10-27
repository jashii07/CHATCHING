// Keeps the current order rows and saves them to a JSON file after every change, so edits survive
// a restart and a page reload. No database (PLAN.md Section 8). On Render the free disk resets on
// restart, so the demo simply loads again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toRows } from "./orders.js";

const DEMO_FILE = new URL("../data/expected-orders.json", import.meta.url);

// The demo's rows: data/expected-orders.json -> toRows(). Used on first start and if the file is broken.
export function demoRows(menu) {
  return toRows(JSON.parse(readFileSync(DEMO_FILE, "utf8")).orders, menu);
}

export function createStore({ file, menu, log = console.log }) {
  let rows = null;
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved?.rows)) throw new Error("no rows list");
      rows = saved.rows;
    } catch (err) {
      log(`Warning: could not read the saved orders (${err.message}), so the demo orders are loaded.`);
    }
  }
  if (!rows) {
    rows = demoRows(menu);
    save();
  }

  // Write to a temporary file first, then rename: a crash mid-write can't leave half a file.
  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ rows }, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  return {
    rows: () => rows,
    find: (id) => rows.find((row) => row.id === id) ?? null,
    replace(updated) {
      rows = rows.map((row) => (row.id === updated.id ? updated : row));
      save();
      return updated;
    },
  };
}
