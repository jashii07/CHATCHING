// Tests for the visitor id, the cookie, the file path, the cleanup (src/visitors.js) and one visitor's
// store (src/store.js). The id comes from the visitor's browser, so nothing about it is trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AGE_MS, MAX_VISITORS, VISITOR_COOKIE, createVisitors, isVisitorId, newVisitorId, visitorFile, visitorIdFrom } from "../src/visitors.js";
import { createStore, newBatchId } from "../src/store.js";
import { invoiceNumber } from "../src/paypal.js";

const DAY = 24 * 60 * 60 * 1000;
const tempDir = () => mkdtempSync(join(tmpdir(), "chatching-visitors-"));
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const row = (id = "r1") => ({ id, buyer: "Lina", invoiceId: null });

// A saved visitor file, last changed `ageDays` days ago.
function saved(dir, id, ageDays) {
  const file = join(dir, `${id}.json`);
  writeFileSync(file, "{}");
  const when = new Date(Date.now() - ageDays * DAY);
  utimesSync(file, when, when);
  return file;
}

// ---- The id ----

test("a visitor id is 128 random bits, written as 32 lowercase hex characters, and never repeats", () => {
  const ids = Array.from({ length: 1000 }, newVisitorId);
  assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)));
  assert.equal(new Set(ids).size, 1000);
  assert.ok(ids.every(isVisitorId));
});

test("only exactly 32 lowercase hex characters count as an id", () => {
  const bad = ["", "abc", "a".repeat(31), "a".repeat(33), "A".repeat(32), "g".repeat(32), `${ID_A}\n`, ` ${ID_A}`,
    "../../../etc/passwd", `${"a".repeat(26)}/../x`, `${"a".repeat(30)}\\.`, null, undefined, 123, [ID_A], { id: ID_A }];
  for (const id of bad) assert.equal(isVisitorId(id), false, JSON.stringify(id));
});

test("the cookie: reads our cookie among others, by its exact name; anything bad is no id at all", () => {
  assert.equal(visitorIdFrom(`${VISITOR_COOKIE}=${ID_A}`), ID_A);
  assert.equal(visitorIdFrom(`theme=dark; ${VISITOR_COOKIE}=${ID_A}; lang=en`), ID_A);
  assert.equal(visitorIdFrom(`x${VISITOR_COOKIE}=${ID_A}`), null, "another cookie that only ends with our name");
  for (const header of [undefined, "", "theme=dark", `${VISITOR_COOKIE}=`, `${VISITOR_COOKIE}=../../orders`, `${VISITOR_COOKIE}=..%2F..%2Forders`, `${VISITOR_COOKIE}=${"A".repeat(32)}`]) {
    assert.equal(visitorIdFrom(header), null, String(header));
  }
});

test("visitorFile: a good id stays inside the folder; anything else is refused before it can touch a path", () => {
  const dir = tempDir();
  assert.equal(visitorFile(dir, ID_A), join(dir, `${ID_A}.json`));
  for (const id of ["../orders", "..\\orders", "", null, `${ID_A}/x`]) assert.throws(() => visitorFile(dir, id), /visitor id/, String(id));
});

// ---- One visitor's store ----

test("a store with no file is an empty table, and no file is written until there is something to save", () => {
  const file = join(tempDir(), `${ID_A}.json`);
  const store = createStore({ file });
  assert.deepEqual([store.rows(), store.source(), store.hasInvoices()], [[], null, false]);
  store.reset();
  store.newBatch();
  assert.equal(existsSync(file), false, "an empty table needs no file, so crawlers and health checks leave no trace");
  store.setAll([row()], { text: "hi", chatDate: "2026-10-28", messages: 1 });
  assert.equal(existsSync(file), true);
});

test("the first save tells the owner once; later saves don't", () => {
  let told = 0;
  const store = createStore({ file: join(tempDir(), `${ID_A}.json`), onNewFile: () => told++ });
  store.setAll([row()], null);
  store.setRows([row("r2")]);
  assert.equal(told, 1);
});

test("a saved table comes back after a restart; a broken file is an empty table with a warning", () => {
  const file = join(tempDir(), `${ID_A}.json`);
  const store = createStore({ file });
  store.setAll([row()], { text: "hi", chatDate: "2026-10-28", messages: 1 });
  const again = createStore({ file });
  assert.deepEqual([again.rows(), again.batch()], [[row()], store.batch()]);

  writeFileSync(file, "{ not json");
  const logs = [];
  const broken = createStore({ file, log: (line) => logs.push(line) });
  assert.deepEqual([broken.rows(), broken.source()], [[], null]);
  assert.match(logs.join(), /could not read/i);
  assert.ok(!logs.join().includes(ID_A), "the id is never logged");
});

test("New batch keeps the old rows and links inside the visitor's own file; Reset keeps them only if invoices were sent", () => {
  const file = join(tempDir(), `${ID_A}.json`);
  const store = createStore({ file });
  store.setAll([{ ...row(), invoiceId: "INV2-1", payerLink: "https://paypal.test/1" }], null);
  const batch = store.batch();
  store.newBatch();
  assert.deepEqual(store.rows(), []);
  store.setAll([row()], null);
  store.reset(); // nothing invoiced in this one: nothing worth keeping
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.rows, []);
  assert.deepEqual(saved.batches.map((b) => [b.batch, b.rows[0].payerLink]), [[batch, "https://paypal.test/1"]]);
  assert.deepEqual(readdirSync(join(file, "..")), [`${ID_A}.json`], "no other files, so the cleanup can't leave anything behind");
});

test("a visitor's saved batches are capped, oldest dropped first, so one file can't grow for ever", () => {
  const file = join(tempDir(), `${ID_A}.json`);
  const store = createStore({ file });
  for (let n = 1; n <= 25; n++) {
    store.setAll([{ ...row(), invoiceId: `INV2-${n}` }], null);
    store.newBatch();
  }
  const { batches } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(batches.length, 20);
  assert.deepEqual([batches[0].rows[0].invoiceId, batches[19].rows[0].invoiceId], ["INV2-6", "INV2-25"]);
});

test("touch marks a saved file as used today; with no file it does nothing", () => {
  const dir = tempDir();
  const file = saved(dir, ID_A, 10);
  createStore({ file }).touch();
  assert.ok(Date.now() - statSync(file).mtimeMs < DAY);
  createStore({ file: join(dir, `${ID_B}.json`) }).touch();
  assert.equal(existsSync(join(dir, `${ID_B}.json`)), false);
});

// ---- Batch ids and invoice numbers, shared by every visitor ----

test("batch ids are 12 random characters (62 bits), and the invoice number still fits PayPal's 25", () => {
  const ids = Array.from({ length: 2000 }, newBatchId);
  assert.ok(ids.every((id) => /^[A-Z0-9]{12}$/.test(id)));
  assert.equal(new Set(ids).size, 2000);
  assert.equal(invoiceNumber(ids[0], 99).length, 25);
});

// ---- The cleanup ----

const open = ({ file }) => ({ file, isBusy: () => false });
const names = (dir) => readdirSync(dir).sort();

test("the limits are the agreed ones: 14 days, 500 visitors", () => {
  assert.equal(MAX_AGE_MS, 14 * DAY);
  assert.equal(MAX_VISITORS, 500);
});

test("cleanup on start: files older than 14 days go, newer ones stay", () => {
  const dir = tempDir();
  saved(dir, ID_A, 15);
  saved(dir, ID_B, 13);
  createVisitors({ dir, open });
  assert.deepEqual(names(dir), [`${ID_B}.json`]);
});

test("cleanup only touches visitor files: nothing else in the folder is removed, however old", () => {
  const dir = tempDir();
  const other = join(dir, "notes.json");
  writeFileSync(other, "{}");
  utimesSync(other, new Date(0), new Date(0));
  createVisitors({ dir, open });
  assert.deepEqual(names(dir), ["notes.json"]);
});

test("cleanup with no folder yet is fine (a fresh disk)", () => {
  assert.doesNotThrow(() => createVisitors({ dir: join(tempDir(), "not-made-yet"), open }));
});

test("over the limit, the oldest files go first until the limit is met", () => {
  const dir = tempDir();
  saved(dir, ID_A, 3);
  saved(dir, ID_B, 1);
  saved(dir, ID_C, 2);
  createVisitors({ dir, open, maxVisitors: 2 });
  assert.deepEqual(names(dir), [`${ID_B}.json`, `${ID_C}.json`]);
});

test("a new visitor's first save runs the cleanup, and never removes that visitor", () => {
  const dir = tempDir();
  saved(dir, ID_A, 3);
  saved(dir, ID_B, 1);
  const visitors = createVisitors({ dir, maxVisitors: 2, open: ({ file, onNewFile }) => ({ isBusy: () => false, save() { writeFileSync(file, "{}"); onNewFile(); } }) });
  visitors.get(ID_C).save();
  assert.deepEqual(names(dir), [`${ID_B}.json`, `${ID_C}.json`]);
});

test("the cleanup also forgets a removed visitor in memory, so old rows can't come back", () => {
  const dir = tempDir();
  const first = saved(dir, ID_A, 3);
  const visitors = createVisitors({ dir, open, maxVisitors: 1 });
  const before = visitors.get(ID_A);
  assert.equal(before.file, first);
  saved(dir, ID_B, 1);
  saved(dir, ID_C, 2);
  visitors.sweep();
  assert.deepEqual(names(dir), [`${ID_B}.json`]);
  assert.notEqual(visitors.get(ID_A), before);
});

test("a busy visitor (reading or sending right now) is never cleaned up, however old", () => {
  const dir = tempDir();
  const visitors = createVisitors({ dir, open: () => ({ isBusy: () => true }) });
  visitors.get(ID_A);
  saved(dir, ID_A, 30);
  visitors.sweep();
  assert.deepEqual(names(dir), [`${ID_A}.json`]);
});

test("memory stays small: past the limit the least recently seen idle visitors are forgotten, busy ones are kept", () => {
  const dir = tempDir();
  const visitors = createVisitors({ dir, maxVisitors: 2, open: ({ file }) => ({ isBusy: () => file.includes(ID_A) }) });
  const a = visitors.get(ID_A); // busy
  const b = visitors.get(ID_B);
  visitors.get(ID_C);
  assert.equal(visitors.loaded(), 2);
  assert.equal(visitors.get(ID_A), a, "the busy visitor keeps their locks");
  assert.notEqual(visitors.get(ID_B), b, "the idle one was forgotten (their file brings them back)");
});
