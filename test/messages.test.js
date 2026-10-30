// Tests for src/messages.js (Step 10, Part 2): ready-to-send texts built by CODE only, no AI. The payment
// message and the reminder for sent invoices, and the question for an unclear order. Names, items, money,
// dates and links are all filled in by the code from the rows and the menu. Exact text, on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buyerMessages, buyerQuestion, paymentMessage, reminderMessage } from "../src/messages.js";
import { toRows } from "../src/orders.js";
import { splitMessages } from "../src/dates.js";
import { checkOrders } from "../src/validate.js";
import { fallbackParse } from "../src/fallback-parse.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const menu = readJson("../data/menu.json");
const expected = readJson("../data/expected-orders.json");
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const LINK = "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST-0001";

// One buyer's rows from the demo answer key, optionally as if their invoice was sent.
const rowsOf = (orders, buyer) => toRows(orders, menu).filter((row) => row.buyer === buyer);
const sent = (rows, invoiceStatus = "Sent") => rows.map((row) => ({ ...row, invoiceId: "INV2-TEST-0001", payerLink: LINK, invoiceStatus }));
const demo = (buyer) => rowsOf(expected.orders, buyer);
const order = (buyer, items, extra = {}) => ({
  buyer, status: "active", sourceMsgs: [1], items: items.map(([itemId, qty]) => ({ itemId, qty })),
  deliveryDate: null, fulfilment: null, unclear: false, reason: "", note: "", ...extra,
});

test("payment message: one item, with pickup or delivery and the day", () => {
  assert.equal(paymentMessage(sent(demo("Lina")), menu),
    `Hi Lina! Your order: 3 x Classic brownies (RM 54.00), delivery Sat 31 Oct. Pay here: ${LINK}. Thank you!`);
  assert.equal(paymentMessage(sent(demo("Aisyah")), menu),
    `Hi Aisyah! Your order: 3 x Classic brownies (RM 54.00), pickup Sat 31 Oct. Pay here: ${LINK}. Thank you!`);
  assert.equal(paymentMessage(sent(demo("Hafiz")), menu),
    `Hi Hafiz! Your order: 1 x Burnt cheesecake 6-inch (RM 45.00), Fri 30 Oct. Pay here: ${LINK}. Thank you!`);
});

test("payment message: several items get a total; no day and no pickup/delivery leave that part out", () => {
  assert.equal(paymentMessage(sent(demo("Mei Ling")), menu),
    `Hi Mei Ling! Your order: 1 x Cheese brownies (RM 22.00) and 2 x Choc chip cookies (RM 50.00), total RM 72.00, Sat 31 Oct. Pay here: ${LINK}. Thank you!`);
  const three = rowsOf([order("Zara", [["cookies", 2], ["bahulu", 1], ["classic_brownies", 1]], { fulfilment: "pickup" })], "Zara");
  assert.equal(paymentMessage(sent(three), menu),
    `Hi Zara! Your order: 2 x Choc chip cookies (RM 50.00), 1 x Kuih bahulu (RM 12.00) and 1 x Classic brownies (RM 18.00), total RM 80.00, pickup. Pay here: ${LINK}. Thank you!`);
  assert.equal(paymentMessage(sent(rowsOf([order("Zara", [["cookies", 2]])], "Zara")), menu),
    `Hi Zara! Your order: 2 x Choc chip cookies (RM 50.00). Pay here: ${LINK}. Thank you!`);
});

test("payment message and reminder only for sent invoices; the reminder only while unpaid", () => {
  assert.equal(paymentMessage(demo("Lina"), menu), null); // no invoice yet
  assert.equal(reminderMessage(demo("Lina"), menu), null);
  assert.equal(reminderMessage(sent(demo("Lina")), menu),
    `Hi Lina! A gentle reminder that your order (RM 54.00) is still unpaid. Pay here: ${LINK}. Thank you!`);
  // Part paid: we don't know what is left, so no amount is named.
  assert.equal(reminderMessage(sent(demo("Lina"), "Part paid"), menu),
    `Hi Lina! A gentle reminder that your order is not fully paid yet. Pay here: ${LINK}. Thank you!`);
  for (const status of ["Paid", "Paid (cash/bank)", "Cancelled/Refunded"]) assert.equal(reminderMessage(sent(demo("Lina"), status), menu), null, status);
  assert.ok(paymentMessage(sent(demo("Lina"), "Paid"), menu)); // still there to copy again
  assert.equal(paymentMessage(sent(demo("Lina"), "Cancelled/Refunded"), menu), null);
});

test("question: an ambiguous item lists the menu's choices with their prices", () => {
  assert.equal(buyerQuestion(demo("Priya"), menu), "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?");
});

test("question: a price mismatch names the menu price and the real total", () => {
  // The demo: Jun Wei thought classic was RM15. 2 x 22.00 + 1 x 18.00 = 62.00.
  assert.equal(buyerQuestion(demo("Jun Wei"), menu), "Hi Jun Wei! Just to check: Classic brownies are RM 18.00 each, so your total is RM 62.00. Is that ok?");
  const cheese = rowsOf([order("Jun Wei", [["cheese_brownies", 2]], { mentionedPrices: [{ text: "RM20", itemId: "cheese_brownies", msg: 1 }] })], "Jun Wei");
  assert.equal(buyerQuestion(cheese, menu), "Hi Jun Wei! Just to check: Cheese brownies are RM 22.00 each, so your total is RM 44.00. Is that ok?");
  // Once the seller clicked "Keep menu price", there is nothing left to ask.
  assert.equal(buyerQuestion(cheese.map((row) => ({ ...row, unclear: false, priceCheck: { ...row.priceCheck, kept: true } })), menu), null);
});

test("question: read without AI (demo) -> cancel, how many, confirm what was read, or which items", () => {
  const messages = splitMessages(DEMO, expected.chatDate);
  const rows = toRows(checkOrders(fallbackParse(messages, menu), messages), menu);
  const texts = buyerMessages(rows, { text: DEMO, chatDate: expected.chatDate }, menu);
  const question = (buyer) => texts.find((t) => t.buyer === buyer).question;
  assert.equal(question("Danish"), "Hi Danish! Just to check: would you still like your order, or shall I cancel it?");
  assert.equal(question("Lina"), "Hi Lina! Just to check: your order is 2 x Classic brownies for Sat 31 Oct. Is that right?");
  assert.equal(question("Arif"), "Hi Arif! Just to check: how many Kuih bahulu would you like?");
  assert.equal(question("Aisyah"), "Hi Aisyah! Just to check: which items would you like, and how many of each?");
  assert.equal(question("Priya"), "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?");
  assert.equal(question("Mei Ling"), null); // clear: nothing to ask
});

test("buyerMessages: one entry per buyer in table order; cancelled buyers get nothing", () => {
  const rows = toRows(expected.orders, menu).map((row) => (row.buyer === "Lina" ? { ...row, invoiceId: "INV2-TEST-0001", payerLink: LINK, invoiceStatus: "Sent" } : row));
  const texts = buyerMessages(rows, null, menu);
  assert.deepEqual(texts.map((t) => t.buyer), expected.orders.map((o) => o.buyer));
  const of = (buyer) => texts.find((t) => t.buyer === buyer);
  assert.deepEqual(Object.keys(of("Lina")), ["buyer", "message", "reminder", "question"]);
  assert.match(of("Lina").message, /^Hi Lina! Your order: 3 x Classic brownies/);
  assert.match(of("Lina").reminder, /^Hi Lina! A gentle reminder/);
  assert.equal(of("Lina").question, null);
  assert.deepEqual(of("Danish"), { buyer: "Danish", message: null, reminder: null, question: null });
  assert.match(of("Priya").question, /^Hi Priya! Which brownies/);
});

test("money follows the menu's currency setting, and every space is a normal space (pastes cleanly)", () => {
  const usd = { ...menu, currency: "USD" };
  const rows = toRows([order("Ben", [["cookies", 1]], { deliveryDate: "2026-11-01" })], usd);
  assert.equal(paymentMessage(sent(rows), usd), `Hi Ben! Your order: 1 x Choc chip cookies ($25.00), Sun 1 Nov. Pay here: ${LINK}. Thank you!`);
  const priya = buyerQuestion(toRows(expected.orders, usd).filter((row) => row.buyer === "Priya"), usd);
  assert.equal(priya, "Hi Priya! Which brownies would you like: Classic ($18.00) or Cheese ($22.00)?");
  for (const text of [paymentMessage(sent(demo("Lina")), menu), buyerQuestion(demo("Jun Wei"), menu)]) assert.ok(!text.includes(" "));
});
