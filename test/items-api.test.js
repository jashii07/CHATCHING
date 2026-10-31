// Tests for adding and removing items in the drawer (after Step 10): POST /api/buyers/:id/items,
// DELETE /api/orders/:id and POST /api/buyers/:id/cancel. The seller can fix an item the AI (or the
// no-AI reader) got wrong, so the buyer can be invoiced. Prices only from the menu; locked once the
// buyer's invoice is sent (the server refuses, not only the page). Every reply carries the whole table,
// so totals, Needs check, the kitchen list and the Copy texts update at once.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi } from "../src/ai.js";
import { toRows } from "../src/orders.js";
import { testVisitor } from "../scripts/test-visitor.mjs";

const CHAT = "2026-10-28";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const menu = readJson("../data/menu.json");
const expected = readJson("../data/expected-orders.json");
const JSON_HEADERS = { "Content-Type": "application/json" };
const LOCKED = "Invoice sent: items are locked so the invoice and the table always match.";

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

// A server with the demo rows (Gemini's saved reply), or with the rows given.
async function start(rows) {
  const { dir: visitorsDir, fetch } = testVisitor(rows ? { rows, source: null } : {});
  const server = createApp(loadConfig({}), { log: () => {}, visitorsDir, ai: createAi({ mode: "mock" }) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const state = async () => (await call("GET", "/api/state")).body;
  return { call, state };
}
const rowsOf = (table, buyer) => table.orders.filter((row) => row.buyer === buyer);
const groupOf = (table, buyer) => table.groups.find((group) => group.buyer === buyer);
const add = (call, id, item) => call("POST", `/api/buyers/${id}/items`, item);

test("add an item: price and total from the menu, next to the buyer's other rows; totals, kitchen and texts follow", async () => {
  const { call, state } = await start();
  const before = await state();
  const lina = rowsOf(before, "Lina")[0];
  const { status, body } = await add(call, lina.id, { itemId: "cookies", qty: 2 });
  assert.equal(status, 200);
  const rows = rowsOf(body, "Lina");
  assert.equal(rows.length, 2);
  const added = rows[1];
  assert.deepEqual([added.itemId, added.qty, added.itemName, added.unitPrice, added.lineTotal], ["cookies", 2, "Choc chip cookies (jar)", "25.00", "50.00"]);
  // The order's day and pickup/delivery come along; it's a new, clear, uninvoiced row with its own id.
  assert.deepEqual([added.deliveryDate, added.fulfilment, added.orderStatus, added.unclear, added.invoiceStatus], ["2026-10-31", "delivery", "active", false, "Draft"]);
  assert.ok(!before.orders.some((row) => row.id === added.id));
  assert.equal(body.orders.indexOf(added), body.orders.indexOf(rows[0]) + 1, "right after Lina's other row");
  assert.deepEqual(body.totals, { orders: 7, total: "416.00" }); // 366.00 + 2 x 25.00
  assert.equal(groupOf(body, "Lina").total, "104.00");
  const saturday = body.kitchen.days.find((day) => day.date === "2026-10-31");
  assert.equal(saturday.items.find((item) => item.name === "Choc chip cookies (jar)").qty, 4); // Mei Ling 2 + Lina 2
  assert.equal(body.texts.find((t) => t.buyer === "Lina").question, null);
  assert.deepEqual((await state()).orders, body.orders, "saved: a reload shows the same rows");
});

test("prices only from the menu: a price, total or any other field in the request is refused", async () => {
  const { call, state } = await start();
  const lina = rowsOf(await state(), "Lina")[0];
  for (const extra of [{ unitPrice: "1.00" }, { lineTotal: "0.00" }, { price: "1" }, { buyer: "Someone else" }]) {
    const { status, body } = await add(call, lina.id, { itemId: "cookies", qty: 1, ...extra });
    assert.equal(status, 400, JSON.stringify(extra));
    assert.match(body.error, /send only itemId and qty/);
  }
  assert.equal(rowsOf(await state(), "Lina").length, 1, "nothing was added");
});

test("a bad item id, a bad quantity, a missing field or an item the buyer already has is refused with the reason", async () => {
  const { call, state } = await start();
  const lina = rowsOf(await state(), "Lina")[0];
  const cases = [
    [{ itemId: "lemon_tart", qty: 1 }, /Unknown menu item "lemon_tart"/],
    [{ itemId: "__proto__", qty: 1 }, /Unknown menu item/],
    [{ itemId: "cookies", qty: 0 }, /Quantity must be a whole number from 1 to 99/],
    [{ itemId: "cookies", qty: 2.5 }, /Quantity must be a whole number from 1 to 99/],
    [{ itemId: "cookies" }, /Send \{ "itemId"/],
    [{ itemId: "classic_brownies", qty: 1 }, /Lina already has Classic brownies \(box of 6\): change its quantity instead/],
  ];
  for (const [item, reason] of cases) {
    const { status, body } = await add(call, lina.id, item);
    assert.equal(status, 400, JSON.stringify(item));
    assert.match(body.error, reason);
  }
  assert.equal((await add(call, "r999", { itemId: "cookies", qty: 1 })).status, 404);
  assert.equal(rowsOf(await state(), "Lina").length, 1);
});

test("remove an item: read without AI, Hafiz has cheesecake + the cookies he took back; removing them makes him invoiceable", async () => {
  const { call } = await start();
  const read = (await call("POST", "/api/parse", { text: DEMO, chatDate: CHAT, withoutAi: true })).body;
  const [cheesecake, cookies] = rowsOf(read, "Hafiz");
  assert.deepEqual([cheesecake.itemId, cookies.itemId], ["burnt_cheesecake", "cookies"]);
  assert.equal(groupOf(read, "Hafiz").total, null, "unclear before");

  const { status, body } = await call("DELETE", `/api/orders/${cookies.id}`);
  assert.equal(status, 200);
  const rows = rowsOf(body, "Hafiz");
  assert.deepEqual(rows.map((row) => [row.id, row.itemId, row.unclear]), [[cheesecake.id, "burnt_cheesecake", false]]);
  // Removing an item is the seller's fix of the whole order: the reader's "please check" goes, our own checks stay.
  assert.equal(groupOf(body, "Hafiz").total, "45.00");
  assert.deepEqual(body.totals, { orders: 2, total: "117.00" }); // Mei Ling 72.00 + Hafiz 45.00
  assert.equal(body.summary.needsCheck, 8);
  assert.equal(body.texts.find((t) => t.buyer === "Hafiz").question, null);
  assert.equal(body.source.reader, "fallback", "still the same read");
});

test("our own checks survive an add: Priya's 'Item missing' row stays unclear until she has an item", async () => {
  const { call, state } = await start();
  const priya = rowsOf(await state(), "Priya")[0];
  const { body } = await add(call, priya.id, { itemId: "cookies", qty: 1 });
  const rows = rowsOf(body, "Priya");
  assert.deepEqual(rows.map((row) => [row.itemId, row.unclear]), [[null, true], ["cookies", false]]);
  assert.match(rows[0].reason, /No menu item chosen/);
  assert.equal(groupOf(body, "Priya").total, null);
  // Removing the empty row is now allowed (she has another item), and she is ready.
  const fixed = (await call("DELETE", `/api/orders/${rows[0].id}`)).body;
  assert.equal(groupOf(fixed, "Priya").total, "25.00");
});

test("the last item can't just disappear: removing it asks for 'cancel the order', which keeps the row as cancelled", async () => {
  const { call, state } = await start();
  const lina = rowsOf(await state(), "Lina")[0];
  const removed = await call("DELETE", `/api/orders/${lina.id}`);
  assert.equal(removed.status, 409);
  assert.deepEqual(removed.body, { error: "This is Lina's last item. Cancel the order instead.", lastItem: true });
  assert.equal(rowsOf(await state(), "Lina")[0].orderStatus, "active");

  const { status, body } = await call("POST", `/api/buyers/${lina.id}/cancel`);
  assert.equal(status, 200);
  assert.deepEqual(rowsOf(body, "Lina").map((row) => [row.orderStatus, row.unclear]), [["cancelled", false]]);
  assert.equal(groupOf(body, "Lina").cancelled, true);
  assert.deepEqual(body.totals, { orders: 6, total: "312.00" }); // 366.00 - 54.00
  assert.deepEqual(body.texts.find((t) => t.buyer === "Lina"), { buyer: "Lina", message: null, reminder: null, question: null });
  // A cancelled order can't be changed: no adding, removing or cancelling again.
  for (const [method, path, item] of [["POST", `/api/buyers/${lina.id}/items`, { itemId: "cookies", qty: 1 }], ["DELETE", `/api/orders/${lina.id}`], ["POST", `/api/buyers/${lina.id}/cancel`]]) {
    const reply = await call(method, path, item);
    assert.equal(reply.status, 400, `${method} ${path}`);
    assert.equal(reply.body.error, "This order is cancelled, so it can't be changed.");
  }
});

test("locked once the buyer's invoice is sent: add, remove, cancel and edit are refused by the SERVER", async () => {
  const rows = toRows(expected.orders, menu).map((row) => (row.buyer === "Mei Ling"
    ? { ...row, invoiceId: "INV2-TEST-0001", invoiceNumber: "CHATCHING-TESTBTCHTEST-01", payerLink: "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-0001", invoiceStatus: "Sent" }
    : row));
  const { call, state } = await start(rows);
  const [cheese, cookies] = rowsOf(await state(), "Mei Ling");
  for (const [method, path, body] of [
    ["POST", `/api/buyers/${cheese.id}/items`, { itemId: "bahulu", qty: 1 }],
    ["DELETE", `/api/orders/${cookies.id}`],
    ["POST", `/api/buyers/${cheese.id}/cancel`],
    ["PUT", `/api/orders/${cheese.id}`, { qty: 3 }],
  ]) {
    const reply = await call(method, path, body);
    assert.equal(reply.status, 400, `${method} ${path}`);
    assert.equal(reply.body.error, LOCKED);
  }
  assert.deepEqual(rowsOf(await state(), "Mei Ling"), [cheese, cookies], "nothing changed");
  // Another buyer without an invoice can still be fixed.
  const hafiz = rowsOf(await state(), "Hafiz")[0];
  assert.equal((await add(call, hafiz.id, { itemId: "bahulu", qty: 1 })).status, 200);
});
