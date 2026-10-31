// Tests for the price mismatch check (Step 7a, PLAN.md Section 5 "mentionedPrices"): the AI only
// REPORTS prices the buyer wrote; our code compares them with menu.json. A match is the unit price,
// the line total or the whole order total. A mismatch (or a price we can't read) makes the row unclear
// until the seller clicks "Keep menu price". The invoice price always comes from the menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPrice } from "../src/prices.js";
import { toRows, recalcRow, checkEdit, totals } from "../src/orders.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));

const order = (items, mentionedPrices, extra = {}) => ({
  buyer: "Mei", status: "active", sourceMsgs: [1, 2], items,
  deliveryDate: "2026-10-31", fulfilment: null, unclear: false, reason: "", note: "", mentionedPrices, ...extra,
});
const classic = (qty) => ({ itemId: "classic_brownies", qty });
// Intl puts a no-break space between "RM" and the number (so they never wrap apart); compare as plain text.
const plain = (text) => text.replace(/ /g, " ");

test("readPrice reads the amount as written, in sen; the currency comes from the menu, not the code", () => {
  assert.equal(readPrice("RM15", "MYR"), 1500);
  assert.equal(readPrice("rm 15.50", "MYR"), 1550);
  assert.equal(readPrice("15 MYR", "MYR"), 1500);
  assert.equal(readPrice("2 for RM36", "MYR"), 3600); // the number next to the currency wins
  assert.equal(readPrice("RM 1,200", "MYR"), 120000);
  assert.equal(readPrice("18", "MYR"), 1800);
  assert.equal(readPrice("$22", "USD"), 2200);
  assert.equal(readPrice("about fifteen", "MYR"), null);
  assert.equal(readPrice("2 boxes 36", "MYR"), null); // two numbers, no currency: can't tell
  assert.equal(readPrice(42, "MYR"), null);
});

test("a mention that matches the unit price, the line total or the order total is fine", () => {
  for (const text of ["RM18", "RM36", "RM 61"]) { // 2 x classic = 36; + 1 cookies jar (25) = 61
    const rows = toRows([order([classic(2), { itemId: "cookies", qty: 1 }], [{ text, itemId: text === "RM 61" ? null : "classic_brownies", msg: 2 }])], menu);
    assert.ok(rows.every((r) => !r.unclear), text);
    assert.equal(rows[0].priceCheck, null, text);
  }
});

test("a wrong price makes that item's row unclear: \"buyer mentioned RM 15.00, menu says RM 18.00.\"", () => {
  const rows = toRows([order([{ itemId: "cookies", qty: 1 }, classic(1)], [{ text: "RM15", itemId: "classic_brownies", msg: 2 }])], menu);
  assert.equal(rows[0].unclear, false); // the cookies row is fine
  assert.equal(rows[1].unclear, true);
  assert.equal(plain(rows[1].reason), "buyer mentioned RM 15.00, menu says RM 18.00.");
  assert.deepEqual({ ...rows[1].priceCheck, reason: plain(rows[1].priceCheck.reason) }, { reason: "buyer mentioned RM 15.00, menu says RM 18.00.", msgs: [2], kept: false });
  assert.equal(rows[1].unitPrice, "18.00"); // the invoice price is still the menu's
  assert.equal(rows[1].lineTotal, "18.00");
  assert.deepEqual(totals(rows), { orders: 0, total: "0.00" }); // blocks invoicing: check first, charge second
});

test("\"menu says\" shows the menu figure nearest to what the buyer wrote", () => {
  const [row] = toRows([order([classic(2)], [{ text: "2 boxes for RM30", itemId: "classic_brownies", msg: 2 }])], menu);
  assert.equal(plain(row.reason), "buyer mentioned RM 30.00, menu says RM 36.00.");
});

test("a price with no item is compared with the whole order and lands on the order's first row", () => {
  const rows = toRows([order([classic(1), { itemId: "cookies", qty: 1 }], [{ text: "RM40 total", itemId: null, msg: 1 }])], menu);
  assert.equal(plain(rows[0].reason), "buyer mentioned RM 40.00, menu says RM 43.00.");
  assert.equal(rows[1].unclear, false);
});

test("an item id that isn't on the menu is treated like no item (compared with the order)", () => {
  const [row] = toRows([order([classic(1)], [{ text: "RM18", itemId: "pizza", msg: 1 }])], menu);
  assert.equal(row.unclear, false);
});

test("a price the code can't read is never ignored: the row becomes unclear", () => {
  const [row] = toRows([order([classic(1)], [{ text: "about fifteen", itemId: "classic_brownies", msg: 2 }])], menu);
  assert.equal(row.unclear, true);
  assert.equal(plain(row.reason), "buyer mentioned \"about fifteen\", which the app can't read as a price.");
  const [broken] = toRows([order([classic(1)], [null, { itemId: "classic_brownies" }])], menu);
  assert.match(broken.reason, /can't read as a price/);
});

test("two problems on one row are both shown; other reasons come first", () => {
  const [row] = toRows([order([classic(1)], [{ text: "RM15", itemId: "classic_brownies", msg: 1 }, { text: "RM10", itemId: "classic_brownies", msg: 2 }], { unclear: true, reason: "Pickup time not given." })], menu);
  assert.equal(plain(row.reason), "Pickup time not given. buyer mentioned RM 15.00, menu says RM 18.00. buyer mentioned RM 10.00, menu says RM 18.00.");
  assert.deepEqual(row.priceCheck.msgs, [1, 2]);
});

test("no mentionedPrices (older replies, or none written) -> no check; cancelled orders are never checked", () => {
  const [plain] = toRows([order([classic(1)], undefined)], menu);
  assert.equal(plain.priceCheck, null);
  const [cancelled] = toRows([order([classic(1)], [{ text: "RM1", itemId: "classic_brownies", msg: 1 }], { status: "cancelled" })], menu);
  assert.deepEqual([cancelled.unclear, cancelled.priceCheck], [false, null]);
});

test("the price check stays through other edits; only \"Keep menu price\" clears it", () => {
  const [row] = toRows([order([classic(1)], [{ text: "RM15", itemId: "classic_brownies", msg: 2 }])], menu);
  const qtyEdit = recalcRow({ ...row, qty: 2 }, menu);
  assert.equal(qtyEdit.unclear, true);
  assert.equal(plain(qtyEdit.reason), "buyer mentioned RM 15.00, menu says RM 18.00.");
  assert.deepEqual(checkEdit({ keepMenuPrice: true }, menu), { changes: { keepMenuPrice: true }, problems: [] });
  const kept = recalcRow({ ...row, priceCheck: { ...row.priceCheck, kept: true } }, menu);
  assert.deepEqual([kept.unclear, kept.reason, kept.unitPrice], [false, "", "18.00"]);
  assert.deepEqual(totals([kept]), { orders: 1, total: "18.00" }); // the invoice uses the menu price
});

test("keepMenuPrice only accepts true", () => {
  assert.match(checkEdit({ keepMenuPrice: false }, menu).problems[0], /keepMenuPrice/);
  assert.match(checkEdit({ keepMenuPrice: "yes" }, menu).problems[0], /keepMenuPrice/);
});

test("rows saved before Step 7 (no priceCheck field) still recalculate", () => {
  const [row] = toRows([order([classic(1)], undefined)], menu);
  const { priceCheck, ...old } = row;
  assert.equal(recalcRow({ ...old, qty: 3 }, menu).unclear, false);
});

test("API: \"Keep menu price\" (PUT { keepMenuPrice: true }) clears the check; the menu price stays", async () => {
  const { testVisitor } = await import("../scripts/test-visitor.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { createApp } = await import("../src/app.js");
  const rows = toRows([order([classic(1)], [{ text: "RM15", itemId: "classic_brownies", msg: 2 }])], menu);
  const { dir: visitorsDir, fetch } = testVisitor({ rows, source: null });
  const server = createApp(loadConfig({}), { log: () => {}, visitorsDir }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const put = async (body) => {
      const res = await fetch(`http://localhost:${server.address().port}/api/orders/r1`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const qty = await put({ qty: 2 });
    assert.equal(qty.body.row.unclear, true); // a qty edit doesn't clear the price check
    assert.equal(qty.body.totals.orders, 0);
    const kept = await put({ keepMenuPrice: true });
    assert.equal(kept.status, 200);
    assert.deepEqual([kept.body.row.unclear, kept.body.row.priceCheck.kept, kept.body.row.lineTotal], [false, true, "36.00"]);
    assert.deepEqual(kept.body.totals, { orders: 1, total: "36.00" });
    assert.deepEqual(await put({ keepMenuPrice: true }), { status: 400, body: { error: "This item has no price to check." } });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
