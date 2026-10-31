// A ready-made visitor for the tests and the browser checks: a temporary folder holding one visitor's file
// (the demo table unless told otherwise), plus a fetch that sends that visitor's cookie. Node's fetch keeps
// no cookies, so without this every request would be a new visitor with an empty table.
// Lives in scripts/, not test/, because node --test would run every .js file under test/ as a test.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRows, demoSource, newBatchId } from "../src/store.js";
import { VISITOR_COOKIE, newVisitorId, visitorFile } from "../src/visitors.js";

const MENU = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));

// A browser page that IS this visitor: its own Playwright context, holding the visitor's cookie.
export async function visitorPage(browser, { id }, base, options = {}) {
  const context = await browser.newContext(options);
  await context.addCookies([{ name: VISITOR_COOKIE, value: id, url: base }]);
  return context.newPage();
}

// rows / source: what the table holds (default: the demo). dir: an existing visitors folder (default: a new one).
export function testVisitor({ rows = demoRows(MENU), source = demoSource(), dir = mkdtempSync(join(tmpdir(), "chatching-")) } = {}) {
  const id = newVisitorId();
  const file = visitorFile(dir, id);
  writeFileSync(file, JSON.stringify({ batch: newBatchId(), rows, source }));
  const cookie = `${VISITOR_COOKIE}=${id}`;
  const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...init.headers, Cookie: cookie } });
  return { id, dir, file, cookie, fetch };
}
