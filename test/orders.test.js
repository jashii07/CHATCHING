// Tests for src/orders.js: prices from the menu, unclear rows, grouping per buyer,
// totals, PayPal status mapping and menu matching. Pure functions: no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toRows, recalcRow, groupByBuyer, totals, mapPayPalStatus, matchMenuItem, checkMenu } from "../src/orders.js";
import { formatMoney } from "../src/money.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const menu = readJson("../data/menu.json");
const expected = readJson("../data/expected-orders.json");

// One active AI order with a single item (the Section 5 shape).
const order = (itemId, qty, extra = {}) => ({
  buyer: "Test", status: "active", sourceMsgs: [1], items: [{ itemId, qty }],
  deliveryDate: "2026-10-31", fulfilment: null, unclear: false, reason: "", note: "", ...extra,
});

test("expected-orders.json -> 7 clear orders worth RM 387.00", () => {
  const rows = toRows(expected.orders, menu);
  assert.deepEqual(totals(rows), { orders: 7, total: "387.00" });
});

test("every buyer's invoice total matches expected-orders.json", () => {
  const groups = groupByBuyer(toRows(expected.orders, menu));
  for (const o of expected.orders.filter((o) => o.total)) {
    const group = groups.find((g) => g.buyer === o.buyer);
    assert.equal(group.total, o.total, o.buyer);
    assert.equal(group.invoiceable, true, o.buyer);
  }
});

test("a row has the Section 5 shape, with the price taken from the menu", () => {
  const [lina] = toRows(expected.orders, menu);
  assert.deepEqual(lina, {
    id: "r1", buyer: "Lina", buyerEmail: null, orderStatus: "active",
    itemId: "classic_brownies", itemName: "Classic brownies (box of 6)", qty: 3,
    unitPrice: "18.00", lineTotal: "54.00",
    deliveryDate: "2026-10-31", fulfilment: "delivery",
    unclear: false, reason: "", note: "Changed from 2 to 3 boxes in message 4.", sourceMsgs: [1, 4],
    invoiceId: null, invoiceNumber: null, payerLink: null, invoiceStatus: "Draft",
  });
});

test("one row per item: Jun Wei's 2 items give 2 rows", () => {
  const rows = toRows(expected.orders, menu).filter((r) => r.buyer === "Jun Wei");
  assert.deepEqual(rows.map((r) => [r.itemId, r.qty, r.lineTotal]), [
    ["cheese_brownies", 2, "44.00"],
    ["classic_brownies", 1, "18.00"],
  ]);
});

test("a price sent by the AI is ignored; only the menu sets prices", () => {
  const [row] = toRows([order("cookies", 1, { items: [{ itemId: "cookies", qty: 1, price: "1.00" }] })], menu);
  assert.equal(row.unitPrice, "25.00");
  assert.equal(row.lineTotal, "25.00");
});

test("Priya (items not stated) -> unclear row, kept, not invoiceable", () => {
  const rows = toRows(expected.orders, menu);
  const priya = rows.filter((r) => r.buyer === "Priya");
  assert.equal(priya.length, 1);
  assert.equal(priya[0].unclear, true);
  assert.match(priya[0].reason, /Same order as last week/);
  assert.equal(priya[0].lineTotal, null);
  assert.equal(groupByBuyer(rows).find((g) => g.buyer === "Priya").invoiceable, false);
});

test("Danish (cancelled) -> stays as a cancelled row, skipped by invoices and totals", () => {
  const rows = toRows(expected.orders, menu);
  const danish = rows.filter((r) => r.buyer === "Danish");
  assert.equal(danish.length, 1);
  assert.equal(danish[0].orderStatus, "cancelled");
  assert.equal(danish[0].unclear, false);
  assert.equal(groupByBuyer(rows).some((g) => g.buyer === "Danish"), false);
});

test("qty 0, 100, 2.5, null or \"3\" -> unclear row with a reason, no line total", () => {
  for (const qty of [0, 100, 2.5, null, "3", -1]) {
    const [row] = toRows([order("cookies", qty)], menu);
    assert.equal(row.unclear, true, `qty ${qty}`);
    assert.match(row.reason, /quantity/i, `qty ${qty}`);
    assert.equal(row.lineTotal, null, `qty ${qty}`);
    assert.equal(row.unitPrice, "25.00", `qty ${qty}`);
  }
  for (const qty of [1, 99]) {
    assert.equal(toRows([order("cookies", qty)], menu)[0].unclear, false, `qty ${qty}`);
  }
});

test("unknown or null itemId -> unclear row with a reason; the unknown id stays visible", () => {
  const [pizza] = toRows([order("pizza", 1)], menu);
  assert.equal(pizza.unclear, true);
  assert.equal(pizza.itemId, "pizza");
  assert.equal(pizza.itemName, null);
  assert.equal(pizza.unitPrice, null);
  assert.match(pizza.reason, /Unknown item "pizza"/);

  const [none] = toRows([order(null, 1)], menu);
  assert.equal(none.unclear, true);
  assert.match(none.reason, /No menu item/);
});

test("the AI's own unclear flag and reason are kept, even when the item is valid", () => {
  const [row] = toRows([order("bahulu", 2, { unclear: true, reason: "Pickup time not given." })], menu);
  assert.equal(row.unclear, true);
  assert.match(row.reason, /Pickup time not given/);
  assert.equal(row.lineTotal, "24.00");
});

test("nothing is dropped: an active order with no items still gives one unclear row", () => {
  const rows = toRows([order(null, null, { items: [] })], menu);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unclear, true);
});

test("a missing buyer name -> unclear row, not dropped", () => {
  const [row] = toRows([order("cookies", 1, { buyer: "  " })], menu);
  assert.equal(row.unclear, true);
  assert.match(row.reason, /Buyer name missing/);
});

test("toRows gives every row a unique id", () => {
  const ids = toRows(expected.orders, menu).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("recalcRow: fixing Priya's item and qty makes the row clear and priced", () => {
  const priya = toRows(expected.orders, menu).find((r) => r.buyer === "Priya");
  const fixed = recalcRow({ ...priya, itemId: "cheese_brownies", qty: 2 }, menu);
  assert.equal(fixed.itemName, "Cheese brownies (box of 6)");
  assert.equal(fixed.unitPrice, "22.00");
  assert.equal(fixed.lineTotal, "44.00");
  assert.equal(fixed.unclear, false);
  assert.equal(fixed.reason, "");
  assert.equal(priya.unclear, true, "the original row is not changed");
});

test("recalcRow: a bad qty edit makes a clear row unclear again", () => {
  const [row] = toRows([order("cookies", 1)], menu);
  const edited = recalcRow({ ...row, qty: 0 }, menu);
  assert.equal(edited.unclear, true);
  assert.equal(edited.lineTotal, null);
});

test("groupByBuyer: a buyer with one clear and one unclear row is not invoiceable", () => {
  const rows = toRows([order("cookies", 1, { buyer: "Ali", items: [{ itemId: "cookies", qty: 1 }, { itemId: null, qty: 1 }] })], menu);
  const [ali] = groupByBuyer(rows);
  assert.equal(ali.buyer, "Ali");
  assert.equal(ali.rows.length, 2);
  assert.equal(ali.invoiceable, false);
  assert.equal(ali.total, null);
  assert.deepEqual(totals(rows), { orders: 0, total: "0.00" });
});

test("groupByBuyer: a cancelled row doesn't block the buyer's other active rows", () => {
  const rows = [
    ...toRows([order("cookies", 2, { buyer: "Ali" })], menu),
    ...toRows([order(null, null, { buyer: "Ali", status: "cancelled", items: [] })], menu),
  ];
  const [ali] = groupByBuyer(rows);
  assert.equal(ali.rows.length, 1);
  assert.equal(ali.invoiceable, true);
  assert.equal(ali.total, "50.00");
});

test("totals of no rows is 0 orders, RM 0.00", () => {
  assert.deepEqual(totals([]), { orders: 0, total: "0.00" });
});

test("mapPayPalStatus follows the PLAN.md Section 5 table", () => {
  const table = {
    Draft: [null, undefined, "DRAFT"],
    Sent: ["SENT", "UNPAID", "SCHEDULED", "PAYMENT_PENDING"],
    "Part paid": ["PARTIALLY_PAID"],
    Paid: ["PAID"],
    "Paid (cash/bank)": ["MARKED_AS_PAID"],
    "Cancelled/Refunded": ["CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"],
  };
  for (const [app, statuses] of Object.entries(table)) {
    for (const s of statuses) assert.equal(mapPayPalStatus(s), app, String(s));
  }
});

test("mapPayPalStatus shows an unknown PayPal status as-is instead of hiding it", () => {
  assert.equal(mapPayPalStatus("SOMETHING_NEW"), "SOMETHING_NEW");
});

test("matchMenuItem: full names win over ambiguous words", () => {
  assert.deepEqual(matchMenuItem("cheese brownies", menu), { itemId: "cheese_brownies", unclear: false, reason: "" });
  assert.equal(matchMenuItem("2 kotak brownies classic", menu).itemId, "classic_brownies");
  assert.equal(matchMenuItem("2x Cheese Brownie", menu).itemId, "cheese_brownies");
  assert.equal(matchMenuItem("nak tempah bahulu 5 pek", menu).itemId, "bahulu");
  assert.equal(matchMenuItem("1 burnt cheesecake 🎂", menu).itemId, "burnt_cheesecake");
});

test("matchMenuItem: \"brwnies\" or plain \"brownies\" -> unclear \"Which brownies: classic or cheese?\"", () => {
  for (const text of ["brwnies 1", "brownies", "nak 2 brownie"]) {
    assert.deepEqual(matchMenuItem(text, menu), { itemId: null, unclear: true, reason: "Which brownies: classic or cheese?" }, text);
  }
});

test("matchMenuItem: no menu word, empty text, or two different items -> unclear", () => {
  assert.equal(matchMenuItem("ada lagi tak?", menu).unclear, true);
  assert.equal(matchMenuItem("", menu).unclear, true);
  assert.equal(matchMenuItem(null, menu).unclear, true);
  const two = matchMenuItem("cheese brownie + 1 classic", menu);
  assert.equal(two.itemId, null);
  assert.match(two.reason, /More than one menu item/);
});

test("matchMenuItem: menu words match whole words only (\"cookiesss\" is not \"cookies\")", () => {
  assert.equal(matchMenuItem("cookiesss", menu).unclear, true);
});

test("currency is one setting: the same orders with USD show \"$\" and give the same totals", () => {
  const usdMenu = { ...menu, currency: "USD" };
  const myr = toRows(expected.orders, menu);
  const usd = toRows(expected.orders, usdMenu);
  assert.deepEqual(totals(usd), totals(myr));
  assert.deepEqual(totals(usd), { orders: 7, total: "387.00" });
  assert.equal(formatMoney(totals(usd).total, usdMenu.currency), "$387.00");
  assert.equal(formatMoney(totals(myr).total, menu.currency).replace(/\u00a0/g, " "), "RM 387.00");
  for (const row of usd.filter((r) => r.lineTotal)) assert.match(formatMoney(row.lineTotal, usdMenu.currency), /^\$\d/);
});

test("checkMenu: the currency must be a real code PayPal can bill in cents", () => {
  assert.deepEqual(checkMenu({ ...menu, currency: "USD" }), []);
  assert.match(checkMenu({ ...menu, currency: "ringgit" }).join(" "), /currency/i);
  assert.match(checkMenu({ ...menu, currency: undefined }).join(" "), /currency/i);
  // PayPal bills JPY, HUF and TWD in whole units only; our prices are "18.00", so refuse them clearly.
  for (const code of ["JPY", "HUF", "TWD"]) assert.match(checkMenu({ ...menu, currency: code }).join(" "), /decimals/i, code);
});
