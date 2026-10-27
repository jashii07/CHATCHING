// Tests for the saved orders: GET /api/state rows + totals, PUT /api/orders/:id, and src/store.js.
// Each server gets its own temporary store file; the real data/runtime/ is never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const tempFile = () => join(mkdtempSync(join(tmpdir(), "chatching-")), "runtime", "orders.json");

const servers = [];
async function start(storeFile, logs = []) {
  const server = createApp(loadConfig({}), { log: (line) => logs.push(line), storeFile }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  return async (path, init) => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: await res.json() };
  };
}
const put = (id, body) => ({ method: "PUT", headers: JSON_HEADERS, body: typeof body === "string" ? body : JSON.stringify(body) });

let file;
let call;
let priya;
before(async () => {
  file = tempFile();
  call = await start(file);
  priya = (await call("/api/state")).body.orders.find((row) => row.buyer === "Priya");
});
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

test("first start loads the demo and saves it to the store file", async () => {
  const { body } = await call("/api/state");
  assert.equal(body.orders.length, 12);
  assert.deepEqual(body.totals, { orders: 7, total: "387.00" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).rows.length, 12);
  assert.equal(priya.unclear, true);
  assert.equal(body.orders.find((row) => row.buyer === "Danish").orderStatus, "cancelled");
});

test("PUT item then qty: Priya's row becomes clear, price and totals come from the server", async () => {
  let res = await call(`/api/orders/${priya.id}`, put(priya.id, { itemId: "classic_brownies" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.row.itemName, "Classic brownies (box of 6)");
  assert.equal(res.body.row.unitPrice, "18.00");
  assert.equal(res.body.row.unclear, true, "qty is still missing");
  assert.equal(res.body.row.reason, "Quantity missing.");

  res = await call(`/api/orders/${priya.id}`, put(priya.id, { qty: 1 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.row.lineTotal, "18.00");
  assert.equal(res.body.row.unclear, false);
  assert.equal(res.body.row.reason, "");
  assert.deepEqual(res.body.totals, { orders: 8, total: "405.00" });
  assert.deepEqual(res.body.summary, { orders: 8, ready: 8, expected: "405.00", paidOrders: 0, paid: "0.00", needsCheck: 0 });
});

test("PUT a date: saved as-is; null clears it", async () => {
  let res = await call(`/api/orders/${priya.id}`, put(priya.id, { deliveryDate: "2026-10-31" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.row.deliveryDate, "2026-10-31");
  res = await call(`/api/orders/${priya.id}`, put(priya.id, { deliveryDate: null }));
  assert.equal(res.body.row.deliveryDate, null);
});

test("the edit survives a restart: a new server on the same file sees it", async () => {
  const again = await start(file);
  const { body } = await again("/api/state");
  const row = body.orders.find((r) => r.id === priya.id);
  assert.equal(row.itemId, "classic_brownies");
  assert.equal(row.qty, 1);
  assert.deepEqual(body.totals, { orders: 8, total: "405.00" });
});

test("bad input -> 400 with a clear message, and the row is unchanged", async () => {
  const before = (await call("/api/state")).body.orders.find((r) => r.id === priya.id);
  const cases = [
    [{ qty: 0 }, /whole number from 1 to 99 \(got 0\)/],
    [{ qty: 2.5 }, /got 2\.5/],
    [{ qty: "2" }, /got "2"/],
    [{ qty: null }, /got null/],
    [{ itemId: "pizza" }, /Unknown menu item "pizza"/],
    [{ itemId: "constructor" }, /Unknown menu item/],
    [{ deliveryDate: "2026-02-30" }, /Not a real date/],
    [{ deliveryDate: "31/10/2026" }, /use YYYY-MM-DD/],
    [{ unitPrice: "0.01" }, /"unitPrice" can't be edited/],
    [{ qty: 2, lineTotal: "1.00" }, /"lineTotal" can't be edited/],
    [{}, /Nothing to change/],
    [[1, 2], /JSON object/],
    ["null", /not valid JSON/], // Express only accepts an object or a list as JSON
    ['"text"', /not valid JSON/],
  ];
  for (const [body, message] of cases) {
    const res = await call(`/api/orders/${priya.id}`, put(priya.id, body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, message, JSON.stringify(body));
  }
  const after = (await call("/api/state")).body.orders.find((r) => r.id === priya.id);
  assert.deepEqual(after, before);
});

test("no body or broken JSON -> 400, never a crash", async () => {
  let res = await call(`/api/orders/${priya.id}`, { method: "PUT" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /JSON object/);
  res = await call(`/api/orders/${priya.id}`, put(priya.id, "{ qty: 2"));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "The request body is not valid JSON.");
});

test("unknown row -> 404; a cancelled row can't be edited -> 400", async () => {
  let res = await call("/api/orders/r999", put("r999", { qty: 1 }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'No order row "r999".');
  const danish = (await call("/api/state")).body.orders.find((r) => r.buyer === "Danish");
  res = await call(`/api/orders/${danish.id}`, put(danish.id, { itemId: "classic_brownies" }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cancelled/);
});

test("a broken store file never stops the server: it logs a warning and loads the demo", async () => {
  for (const content of ["{ not json", '{"rows": "nope"}', "null", ""]) {
    const broken = tempFile();
    await start(broken); // creates the folder + demo file
    writeFileSync(broken, content);
    const logs = [];
    const fresh = await start(broken, logs);
    const { body } = await fresh("/api/state");
    assert.equal(body.orders.length, 12, JSON.stringify(content));
    assert.match(logs.join("\n"), /could not read the saved orders/);
  }
});

test("the store remembers which chats the rows came from (demo: 15 messages, Chat date 28 Oct)", async () => {
  const { body } = await call("/api/state");
  assert.equal(body.source.messages, 15);
  assert.equal(body.source.chatDate, "2026-10-28");
  assert.match(body.source.text, /^\[28\/10 9:02 AM\] Lina:/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).source.messages, 15);
});
