// Tests for src/kitchen.js (Step 10b): per date, how many of each item to make. Pure: no server.
// Plus the API: the kitchen list rides along with /api/state and every edit, so it is never stale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitchenList } from "../src/kitchen.js";
import { toRows, recalcRow } from "../src/orders.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const menu = readJson("../data/menu.json");
const expected = readJson("../data/expected-orders.json");

// One active AI order (the Section 5 shape); items as [itemId, qty] pairs.
const order = (buyer, deliveryDate, items, extra = {}) => ({
  buyer, status: "active", sourceMsgs: [1], items: items.map(([itemId, qty]) => ({ itemId, qty })),
  deliveryDate, fulfilment: null, unclear: false, reason: "", note: "", ...extra,
});
const kitchen = (orders) => kitchenList(toRows(orders, menu), menu);
// The days without the text, as [label, [[qty, name]...], toCheck], to keep the tests short.
const brief = (list) => list.days.map((day) => [day.label, day.items.map((item) => [item.qty, item.name]), day.toCheck]);

test("demo orders: grouped by date (earliest first), items in menu order", () => {
  assert.deepEqual(brief(kitchen(expected.orders)), [
    ["Thu 29 Oct", [[2, "Kuih bahulu (pack of 20)"]], 0],
    ["Fri 30 Oct", [[1, "Burnt cheesecake 6-inch"]], 0],
    // Lina 3 + Aisyah 3 ("same as Lina"); Jun Wei (price to check) and Priya (which brownies) are not counted.
    ["Sat 31 Oct", [[6, "Classic brownies (box of 6)"], [1, "Cheese brownies (box of 6)"], [1, "Burnt cheesecake 6-inch"], [2, "Choc chip cookies (jar)"]], 2],
    ["Sun 1 Nov", [[6, "Kuih bahulu (pack of 20)"]], 0],
  ]);
});

test("each day carries its ISO date and each item its menu id", () => {
  const sat = kitchen(expected.orders).days[2];
  assert.equal(sat.date, "2026-10-31");
  assert.deepEqual(sat.items[0], { itemId: "classic_brownies", name: "Classic brownies (box of 6)", qty: 6 });
});

test('"same as Lina" counts as its own order: both buyers\' boxes are added up', () => {
  const list = kitchen([
    order("Lina", "2026-10-31", [["classic_brownies", 3]]),
    order("Aisyah", "2026-10-31", [["classic_brownies", 3]], { note: "Same as Lina's final order." }),
  ]);
  assert.deepEqual(brief(list), [["Sat 31 Oct", [[6, "Classic brownies (box of 6)"]], 0]]);
});

test("cancelled orders are left out", () => {
  const list = kitchen([
    order("Lina", "2026-10-31", [["classic_brownies", 3]]),
    order("Danish", "2026-10-31", [["cookies", 4]], { status: "cancelled" }),
  ]);
  assert.deepEqual(brief(list), [["Sat 31 Oct", [[3, "Classic brownies (box of 6)"]], 0]]);
});

test("a buyer whose PayPal invoice was cancelled or refunded is left out", () => {
  const rows = toRows([order("Lina", "2026-10-31", [["classic_brownies", 3]]), order("Hafiz", "2026-10-31", [["cookies", 1]])], menu);
  rows[0] = { ...rows[0], invoiceStatus: "Cancelled/Refunded" };
  assert.deepEqual(brief(kitchenList(rows, menu)), [["Sat 31 Oct", [[1, "Choc chip cookies (jar)"]], 0]]);
});

test("invoiced and paid orders still count: the seller still has to make them", () => {
  const rows = toRows([order("Lina", "2026-10-31", [["classic_brownies", 3]]), order("Hafiz", "2026-10-31", [["classic_brownies", 1]])], menu);
  rows[0] = { ...rows[0], invoiceId: "INV2-A", invoiceStatus: "Paid" };
  rows[1] = { ...rows[1], invoiceId: "INV2-B", invoiceStatus: "Sent" };
  assert.deepEqual(brief(kitchenList(rows, menu)), [["Sat 31 Oct", [[4, "Classic brownies (box of 6)"]], 0]]);
});

test("unclear orders are not counted but shown under their date; a day can hold only unclear orders", () => {
  const list = kitchen([
    order("Lina", "2026-10-31", [["classic_brownies", 3]]),
    order("Priya", "2026-10-31", [[null, 2]], { unclear: true, reason: "Which brownies: classic or cheese?" }),
    order("Hafiz", "2026-11-01", [["burnt_cheesecake", 1]], { unclear: true, reason: "Which size?" }),
  ]);
  assert.deepEqual(brief(list), [
    ["Sat 31 Oct", [[3, "Classic brownies (box of 6)"]], 1],
    ["Sun 1 Nov", [], 1],
  ]);
});

test("one order = one buyer: a buyer with one unclear row is not counted at all, and counts once", () => {
  const list = kitchen([
    order("Jun Wei", "2026-10-31", [["cheese_brownies", 2], ["classic_brownies", 1]], {
      mentionedPrices: [{ text: "RM15", itemId: "classic_brownies", msg: 1 }],
    }),
  ]);
  assert.deepEqual(brief(list), [["Sat 31 Oct", [], 1]]);
});

test('orders with no date go in a "No date yet" group, after the dated days', () => {
  const list = kitchen([
    order("Lina", null, [["classic_brownies", 3]]),
    order("Hafiz", "2026-10-30", [["cookies", 1]]),
    order("Priya", null, [[null, 2]], { unclear: true, reason: "Which brownies?" }),
  ]);
  assert.deepEqual(brief(list), [
    ["Fri 30 Oct", [[1, "Choc chip cookies (jar)"]], 0],
    ["No date yet", [[3, "Classic brownies (box of 6)"]], 1],
  ]);
  assert.equal(list.days[1].date, null);
});

test("several dates come out earliest first, whatever the order in the chat; days with no orders are not shown", () => {
  const list = kitchen([
    order("A", "2026-11-03", [["cookies", 1]]),
    order("B", "2026-10-29", [["cookies", 1]]),
    order("C", "2026-11-01", [["cookies", 1]]),
  ]);
  assert.deepEqual(list.days.map((day) => day.date), ["2026-10-29", "2026-11-01", "2026-11-03"]);
});

test("a buyer with rows on two dates: each row counts on its own date; the order to check shows on both", () => {
  const rows = toRows([order("Lina", "2026-10-31", [["classic_brownies", 2], ["cookies", 1]])], menu);
  rows[1] = { ...rows[1], deliveryDate: "2026-11-01" };
  assert.deepEqual(brief(kitchenList(rows, menu)), [
    ["Sat 31 Oct", [[2, "Classic brownies (box of 6)"]], 0],
    ["Sun 1 Nov", [[1, "Choc chip cookies (jar)"]], 0],
  ]);
  rows[0] = recalcRow({ ...rows[0], itemId: null }, menu);
  assert.deepEqual(brief(kitchenList(rows, menu)), [["Sat 31 Oct", [], 1], ["Sun 1 Nov", [], 1]]);
});

test("no rows: no days, and the text says there is nothing to make", () => {
  assert.deepEqual(kitchenList([], menu), { days: [], text: "Kitchen list\n\nNothing to make yet." });
});

test("the copied text is exactly right: one line per item, a blank line between days", () => {
  assert.equal(kitchen(expected.orders).text, [
    "Kitchen list",
    "",
    "Thu 29 Oct",
    "2 x Kuih bahulu (pack of 20)",
    "",
    "Fri 30 Oct",
    "1 x Burnt cheesecake 6-inch",
    "",
    "Sat 31 Oct",
    "6 x Classic brownies (box of 6)",
    "1 x Cheese brownies (box of 6)",
    "1 x Burnt cheesecake 6-inch",
    "2 x Choc chip cookies (jar)",
    "+2 orders still to check",
    "",
    "Sun 1 Nov",
    "6 x Kuih bahulu (pack of 20)",
  ].join("\n"));
});

test('text: "+1 order" (singular) and the "No date yet" group', () => {
  const list = kitchen([order("Priya", null, [[null, 2]], { unclear: true, reason: "Which brownies?" })]);
  assert.equal(list.text, "Kitchen list\n\nNo date yet\n+1 order still to check");
});

// ---- The API: the list comes with /api/state and with every edit ----

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));
async function start() {
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "runtime", "orders.json");
  const server = createApp(loadConfig({}), { log: () => {}, storeFile }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  return async (path, body) => {
    const init = body && { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(base + path, init);
    return res.json();
  };
}
const saturday = (list) => brief(list).find(([label]) => label === "Sat 31 Oct");

test("API: /api/state has the kitchen list; edits and \"Keep menu price\" update it", async () => {
  const call = await start();
  const state = await call("/api/state");
  assert.deepEqual(state.kitchen, kitchenList(state.orders, menu));
  assert.deepEqual(saturday(state.kitchen)[2], 2);

  // Priya: choose the item -> her 2 boxes count, one fewer order to check.
  const priya = state.orders.find((row) => row.buyer === "Priya");
  let reply = await call(`/api/orders/${priya.id}`, { itemId: "classic_brownies" });
  assert.deepEqual(saturday(reply.kitchen), ["Sat 31 Oct", [[8, "Classic brownies (box of 6)"], [1, "Cheese brownies (box of 6)"], [1, "Burnt cheesecake 6-inch"], [2, "Choc chip cookies (jar)"]], 1]);

  // Jun Wei: "Keep menu price" -> 2 cheese + 1 classic count, nothing left to check.
  const junWei = state.orders.find((row) => row.buyer === "Jun Wei" && row.priceCheck);
  reply = await call(`/api/orders/${junWei.id}`, { keepMenuPrice: true });
  assert.deepEqual(saturday(reply.kitchen), ["Sat 31 Oct", [[9, "Classic brownies (box of 6)"], [3, "Cheese brownies (box of 6)"], [1, "Burnt cheesecake 6-inch"], [2, "Choc chip cookies (jar)"]], 0]);

  // Moving Lina to Sunday moves her 3 boxes with her.
  const lina = state.orders.find((row) => row.buyer === "Lina");
  reply = await call(`/api/orders/${lina.id}`, { deliveryDate: "2026-11-01" });
  assert.deepEqual(saturday(reply.kitchen)[1][0], [6, "Classic brownies (box of 6)"]);
  assert.deepEqual(brief(reply.kitchen).at(-1), ["Sun 1 Nov", [[3, "Classic brownies (box of 6)"], [6, "Kuih bahulu (pack of 20)"]], 0]);
});
