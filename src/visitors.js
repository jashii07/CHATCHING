// Every browser gets its own table (DECISIONS.md, 31 Oct): on the live site two judges must never see or
// reset each other's orders. A browser is known by a random id in a cookie; there is no login.
// The id only picks which file holds the table. It comes from the browser, so it is never trusted: anything
// that isn't exactly 32 lowercase hex characters counts as no id at all, and is never put in a path.
// Saved tables: data/runtime/visitors/<id>.json. An empty table has no file, so a crawler or a health check
// leaves nothing behind. Cleanup: files older than 14 days go, and at most 500 stay (oldest removed first).
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const VISITOR_COOKIE = "chatching_visitor";
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_VISITORS = 500;

const ID = /^[0-9a-f]{32}$/;
const FILE = /^([0-9a-f]{32})\.json$/;

export const newVisitorId = () => randomBytes(16).toString("hex"); // 128 random bits
export const isVisitorId = (id) => typeof id === "string" && ID.test(id);

// The Cookie header -> the id, or null when it is missing or not a good id.
export function visitorIdFrom(header = "") {
  const value = header.match(new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([^;]*)`))?.[1];
  return isVisitorId(value) ? value : null;
}

// The only place an id becomes a path, so a bad one can never reach the file system.
export function visitorFile(dir, id) {
  if (!isVisitorId(id)) throw new RangeError("Bad visitor id.");
  return join(dir, `${id}.json`);
}

// The visitors the server knows. open({ file, onNewFile }) makes one visitor's table and locks, and each
// visitor has isBusy(): true while reading or sending. A busy visitor is never cleaned up or forgotten.
// Memory is capped like the files: past the limit the least recently seen idle visitors are forgotten (their
// file brings them back), so requests without a cookie can't fill the server's memory.
export function createVisitors({ dir, open, now = Date.now, maxAgeMs = MAX_AGE_MS, maxVisitors = MAX_VISITORS }) {
  const loaded = new Map(); // id -> visitor, least recently seen first

  function savedFiles() {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return []; // no folder yet: a fresh disk
    }
    return names.flatMap((name) => {
      const id = name.match(FILE)?.[1];
      return id ? [{ id, file: join(dir, name), changed: statSync(join(dir, name)).mtimeMs }] : [];
    }).sort((a, b) => a.changed - b.changed);
  }

  // keep: the visitor saving right now, who must not lose their brand-new file.
  function sweep(keep = null) {
    const files = savedFiles();
    let left = files.length;
    for (const { id, file, changed } of files) {
      if (left <= maxVisitors && now() - changed <= maxAgeMs) break; // oldest first: the rest are newer
      if (id === keep || loaded.get(id)?.isBusy()) continue;
      rmSync(file, { force: true });
      loaded.delete(id);
      left--;
    }
  }

  function forgetIdle() {
    for (const [id, visitor] of loaded) {
      if (loaded.size <= maxVisitors) break;
      if (!visitor.isBusy()) loaded.delete(id);
    }
  }

  sweep();

  return {
    get(id) {
      const visitor = loaded.get(id) ?? open({ file: visitorFile(dir, id), onNewFile: () => sweep(id) });
      loaded.delete(id);
      loaded.set(id, visitor); // back to the end: just seen
      forgetIdle();
      return visitor;
    },
    sweep,
    loaded: () => loaded.size,
  };
}
