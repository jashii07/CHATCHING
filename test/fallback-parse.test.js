// Tests for src/fallback-parse.js (Step 10, Part 1): reading chats WITHOUT the AI, for when Gemini is busy,
// slow or used up. Careful, not clever: anything it isn't sure of becomes unclear, so it must never give a
// wrong invoiceable order. Its orders go through the same checks as the AI's (checkOrders + toRows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fallbackParse } from "../src/fallback-parse.js";
import { splitMessages } from "../src/dates.js";
import { checkOrders } from "../src/validate.js";
import { groupByBuyer, toRows, totals } from "../src/orders.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const menu = readJson("../data/menu.json");
const expected = readJson("../data/expected-orders.json");
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");

// Chats -> the fallback's orders, and the table rows they become (the same path as an AI reply).
function read(text, chatDate = "2026-10-30") {
  const messages = splitMessages(text, chatDate);
  const orders = fallbackParse(messages, menu);
  return { orders, rows: toRows(checkOrders(orders, messages), menu) };
}
const order = (orders, buyer) => orders.find((o) => o.buyer === buyer);
const items = (o) => o.items.map((item) => [item.itemId, item.qty]);

test("a simple chat -> correct clear orders: items, numbers, number words, day words, pickup/delivery", () => {
  const { orders, rows } = read([
    "[30/10 9:00 AM] Zara: 2 jars of cookies for saturday pls",
    "[30/10 9:05 AM] Ben: 1 cheese brownies and 2 classic, pick up tomorrow",
    "[30/10 9:10 AM] Chloe: Hi! one burnt cheesecake for sunday, deliver please",
    "[30/10 9:20 AM] Dev: 2x bahulu + a jar of cookies",
  ].join("\n"));
  assert.deepEqual(orders.map((o) => o.buyer), ["Zara", "Ben", "Chloe", "Dev"]);
  assert.deepEqual(items(order(orders, "Zara")), [["cookies", 2]]);
  assert.deepEqual(items(order(orders, "Ben")), [["cheese_brownies", 1], ["classic_brownies", 2]]);
  assert.deepEqual(items(order(orders, "Chloe")), [["burnt_cheesecake", 1]]);
  assert.deepEqual(items(order(orders, "Dev")), [["bahulu", 2], ["cookies", 1]]);
  // Fri 30 Oct: "saturday" and "tomorrow" are Sat 31 Oct, "sunday" is Sun 1 Nov.
  assert.deepEqual(orders.map((o) => o.deliveryDate), ["2026-10-31", "2026-10-31", "2026-11-01", null]);
  assert.deepEqual(orders.map((o) => o.fulfilment), [null, "pickup", "delivery", null]);
  assert.deepEqual(orders.map((o) => o.sourceMsgs), [[1], [2], [3], [4]]);
  assert.ok(orders.every((o) => o.status === "active" && !o.unclear && o.reason === ""));
  // Prices from the menu, as always: 50 + (22 + 36) + 45 + (24 + 25).
  assert.ok(rows.every((row) => !row.unclear));
  assert.deepEqual(totals(rows), { orders: 4, total: "202.00" });
});

test("times, sizes, 'box of 6' and a matching price are not read as quantities", () => {
  const { orders, rows } = read([
    "[30/10 9:00 AM] Zara: 1 cheesecake 6 inch, pick up at 3:30pm on saturday",
    "[30/10 9:05 AM] Ben: 2 box of 6 classic, so RM36 right?",
  ].join("\n"));
  assert.deepEqual(items(order(orders, "Zara")), [["burnt_cheesecake", 1]]);
  assert.deepEqual(items(order(orders, "Ben")), [["classic_brownies", 2]]);
  assert.deepEqual(order(orders, "Ben").mentionedPrices, [{ text: "RM36", itemId: null, msg: 2 }]);
  assert.ok(rows.every((row) => !row.unclear), rows.map((row) => row.reason).join(" | "));
});

test("the demo chats read without AI: NO wrong invoiceable order (only Mei Ling is clear, and she is right)", () => {
  const { rows } = read(DEMO, expected.chatDate);
  const want = new Map(expected.orders.map((o) => [o.buyer, o]));
  const invoiceable = groupByBuyer(rows).filter((group) => group.invoiceable);
  for (const group of invoiceable) {
    const truth = want.get(group.buyer);
    assert.equal(truth?.status, "active", `${group.buyer} is invoiceable but is not an active demo order`);
    assert.deepEqual(group.rows.map((row) => [row.itemId, row.qty]), truth.items.map((item) => [item.itemId, item.qty]), group.buyer);
    assert.equal(group.total, truth.total, group.buyer);
    assert.ok(group.rows.every((row) => row.deliveryDate === truth.deliveryDate), group.buyer);
  }
  // Pinned, so the count we report is the real one: 1 clear, 9 to check.
  assert.deepEqual(invoiceable.map((group) => group.buyer), ["Mei Ling"]);
  assert.equal(groupByBuyer(rows).filter((group) => !group.invoiceable).length, 9);
});

test("the demo chats: changes, cancellations, 'same as', ambiguous items and wrong prices each say why", () => {
  const { orders, rows } = read(DEMO, expected.chatDate);
  const reason = (buyer) => order(orders, buyer).reason;
  assert.match(reason("Lina"), /^read without AI, this buyer changed their order/);
  assert.match(reason("Hafiz"), /^read without AI, this buyer changed their order/);
  assert.match(reason("Kak Ros"), /^read without AI, this buyer changed their order/);
  assert.match(reason("Danish"), /^read without AI, this buyer may have cancelled/);
  assert.match(reason("Aisyah"), /^read without AI, this buyer wrote "same as"/);
  assert.equal(reason("Priya"), "read without AI, which brownies: classic or cheese?");
  assert.deepEqual(items(order(orders, "Priya")), [[null, 2]]);
  // Never cancelled by the fallback: a cancellation is the seller's call.
  assert.equal(order(orders, "Danish").status, "active");
  // Jun Wei: his own order is read right, and his RM15 is compared with the menu by the usual code.
  assert.deepEqual(items(order(orders, "Jun Wei")), [["cheese_brownies", 2], ["classic_brownies", 1]]);
  const junWei = rows.filter((row) => row.buyer === "Jun Wei");
  assert.equal(junWei[1].priceCheck.reason.replaceAll(" ", " "), "buyer mentioned RM 15.00, menu says RM 18.00."); // Intl puts a no-break space after "RM"
  // Every order lists all its buyer's messages, so the buyer panel shows them all.
  assert.deepEqual(order(orders, "Lina").sourceMsgs, [1, 4, 18]);
  assert.deepEqual(order(orders, "Hafiz").sourceMsgs, [2, 11, 15]);
});

test("unclear, not guessed: unknown items, items in two messages, a missing quantity, two days, 'next'", () => {
  const { orders } = read([
    "[30/10 9:00 AM] Ana: 2 lemon tarts and 1 classic",
    "[30/10 9:05 AM] Ben: 1 classic for saturday",
    "[30/10 9:06 AM] Ben: 1 cookies too",
    "[30/10 9:10 AM] Cai: can i get cheesecake for saturday?",
    "[30/10 9:20 AM] Dee: 1 classic saturday, 1 cookies sunday",
    "[30/10 9:30 AM] Eva: 1 classic for next saturday",
    "[30/10 9:40 AM] Fay: 2 classic 3",
  ].join("\n"));
  const reason = (buyer) => order(orders, buyer).reason;
  assert.ok(orders.every((o) => o.unclear), orders.map((o) => `${o.buyer}: ${o.reason}`).join(" | "));
  assert.match(reason("Ana"), /"2 lemon tarts" has a number but no menu item/);
  assert.match(reason("Ben"), /items in more than one message/);
  assert.match(reason("Cai"), /no quantity for Burnt cheesecake 6-inch/);
  assert.deepEqual(items(order(orders, "Cai")), [["burnt_cheesecake", null]]);
  assert.match(reason("Dee"), /more than one day/);
  assert.match(reason("Eva"), /"next saturday" could mean two dates/);
  assert.match(reason("Fay"), /more than one number for Classic brownies/);
});

test("a message with no buyer name -> an unclear order with no name (the row says so), nothing dropped", () => {
  const { orders, rows } = read("2 classic for saturday please", "2026-10-30");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].buyer, "");
  assert.equal(rows[0].unclear, true);
  assert.match(rows[0].reason, /this message has no buyer name.*Buyer name missing/);
});

test("empty input -> no orders, no crash", () => {
  assert.deepEqual(fallbackParse([], menu), []);
  assert.deepEqual(read("   \n  ").orders, []);
});

// A tiny seeded random number generator, so a failing fuzz case can be found again.
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("fuzz: 400 random pastes never crash, and every clear row has a menu item, a quantity and a menu price", () => {
  const random = seeded(20261030);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = ["classic", "cheese", "brownies", "brwnies", "cheesecake", "bahulu", "cookies", "x", "2x", "x3", "1", "2", "99", "100", "0",
    "-1", "1.5", "one", "a", "dua", "box", "of", "6", "RM15", "rm", "$", "10:30", "3pm", "31/10", "29/2", "saturday", "esok", "next",
    "tomorrow", "cancel", "same as", "make it", "and", "+", ",", ".", "?", "!", ":", "::", "pick up", "deliver", "🎂", "‎", "\n",
    "[", "]", "[28/10 9:02 AM]", "[31/4 9:00]", "[28/10 25:00]", "Lina:", "Kak Ros:", "12345678", "inch", "constructor", "__proto__"];
  const chars = "abcxyz019:/[]()+,.?!-–\n\t 🎂‎";
  for (let i = 0; i < 400; i++) {
    const pieces = Array.from({ length: Math.floor(random() * 40) }, () =>
      random() < 0.8 ? pick(words) : Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(chars)).join(""));
    const text = pieces.join(random() < 0.5 ? " " : "");
    let rows;
    assert.doesNotThrow(() => (rows = read(text, "2026-10-28").rows), `paste ${i}: ${JSON.stringify(text)}`);
    for (const row of rows.filter((r) => !r.unclear && r.orderStatus === "active")) {
      assert.ok(menu.items.some((item) => item.id === row.itemId && item.price === row.unitPrice), `paste ${i}: ${JSON.stringify(row)}`);
      assert.ok(Number.isInteger(row.qty) && row.qty >= 1 && row.qty <= 99, `paste ${i}: ${JSON.stringify(row)}`);
    }
  }
});
