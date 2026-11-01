// Seller messages (1 Nov): real chats hold the seller's replies. They are context only: they never create a
// buyer or an order, and a price the seller writes is never compared or used. "sellerName" in menu.json says
// who the seller is. The prompt asks for this, and our code enforces it whatever the AI (or the reader) does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildParsePrompt } from "../src/ai-prompt.js";
import { scoreReply } from "../src/accuracy.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { splitMessages } from "../src/dates.js";
import { fallbackParse } from "../src/fallback-parse.js";
import { buyerMessages } from "../src/messages.js";
import { checkMenu, groupByBuyer, toRows } from "../src/orders.js";
import { isSeller, isSellerMessage, senderOf } from "../src/seller.js";
import { checkOrders, sellerOrders } from "../src/validate.js";
import { testVisitor } from "../scripts/test-visitor.mjs";

const DEMO_MENU = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const EXPECTED = JSON.parse(readFileSync(new URL("../data/expected-orders.json", import.meta.url), "utf8"));
const MENU = {
  currency: "MYR", sellerName: "Cafe",
  items: [{ id: "latte", name: "Latte", price: "12.00", aliases: ["latte"] }, { id: "mocha", name: "Mocha", price: "14.00", aliases: ["mocha"] }],
};
const CHAT = "2026-11-01";
const PASTE = [
  "[1/11 9:00 AM] Ali: 2 latte for tomorrow pls",
  "[1/11 9:05 AM] Cafe: Thanks Ali! 2 latte, total RM31. Mocha is RM9 today",
  "[1/11 9:06 AM] Ali: ok",
].join("\n");
const messages = splitMessages(PASTE, CHAT);
const order = (extra = {}) => ({
  buyer: "Ali", status: "active", sourceMsgs: [1, 3], items: [{ itemId: "latte", qty: 2 }],
  deliveryDate: "2026-11-02", fulfilment: null, unclear: false, reason: "", note: "", ...extra,
});

test("checkMenu: sellerName is optional, and must be a name when it is there", () => {
  assert.deepEqual(checkMenu(MENU), []);
  assert.deepEqual(checkMenu({ ...MENU, sellerName: undefined }), []);
  for (const sellerName of ["", "  ", 5, null]) {
    assert.deepEqual(checkMenu({ ...MENU, sellerName }), [`Bad sellerName ${JSON.stringify(sellerName)}: use the name the seller has in the chats.`]);
  }
});

test("the demo menu has a seller who is none of the demo buyers", () => {
  assert.equal(typeof DEMO_MENU.sellerName, "string");
  assert.ok(!EXPECTED.orders.some((o) => isSeller(o.buyer, DEMO_MENU)));
});

test("senderOf reads the name before the colon; isSeller ignores case and spaces; no sellerName means nobody", () => {
  assert.equal(senderOf("Cafe: Thanks"), "Cafe");
  assert.equal(senderOf("Thanks, see you at 3:30"), "");
  assert.equal(senderOf(null), "");
  assert.ok(isSeller(" cafe ", MENU));
  assert.ok(!isSeller("Cafe Lina", MENU));
  assert.ok(!isSeller("", MENU));
  assert.ok(!isSeller("Cafe", { ...MENU, sellerName: undefined }));
  assert.ok(isSellerMessage(messages[1], MENU));
  assert.ok(!isSellerMessage(messages[0], MENU));
  assert.ok(!isSellerMessage(undefined, MENU));
});

test("the prompt names the seller and says their messages are context only", () => {
  const { prompt } = buildParsePrompt({ paste: PASTE, chatDate: CHAT, menu: MENU });
  assert.match(prompt, /The seller is "Cafe"\. Messages from Cafe are replies/);
  assert.match(prompt, /never creates an order/);
  assert.match(prompt, /never go in mentionedPrices/);
  assert.doesNotMatch(buildParsePrompt({ paste: PASTE, chatDate: CHAT, menu: { ...MENU, sellerName: undefined } }).prompt, /The seller is/);
});

test("an order in the seller's name is removed, whatever the spelling", () => {
  for (const buyer of ["Cafe", "cafe", " CAFE "]) {
    const checked = checkOrders([order({ buyer, sourceMsgs: [2] }), order()], messages, MENU);
    assert.deepEqual(checked.map((o) => o.buyer), ["Ali"]);
  }
});

test("an order for a stranger made only from the seller's reply is removed: it creates no buyer", () => {
  const chat = splitMessages("[1/11 9:00 AM] Cafe: Maya's 3 latte are ready, RM36", CHAT);
  assert.deepEqual(checkOrders([order({ buyer: "Maya", sourceMsgs: [1], items: [{ itemId: "latte", qty: 3 }] })], chat, MENU), []);
});

test("sellerOrders names what is removed, so a report can say so", () => {
  const removed = sellerOrders([order(), order({ buyer: "Cafe", sourceMsgs: [2] }), null], messages, MENU);
  assert.deepEqual(removed.map((o) => o.buyer), ["Cafe"]);
});

test("a real buyer whose order cites only the seller's reply is kept, but needs a check", () => {
  const [checked] = checkOrders([order({ sourceMsgs: [2] })], messages, MENU);
  assert.equal(checked.unclear, true);
  assert.match(checked.reason, /only from the seller's messages/);
});

test("the seller's confirmation may be a source of a real buyer's order", () => {
  const [checked] = checkOrders([order({ sourceMsgs: [1, 2, 3] })], messages, MENU);
  assert.equal(checked.unclear, false);
  assert.deepEqual(checked.sourceMsgs, [1, 2, 3]);
});

test("a price the seller wrote is ignored: no check, and the invoice price stays the menu's", () => {
  const ai = order({ sourceMsgs: [1, 2, 3], mentionedPrices: [{ text: "RM31", itemId: null, msg: 2 }, { text: "RM9", itemId: "mocha", msg: 2 }] });
  const input = structuredClone(ai);
  const [checked] = checkOrders([ai], messages, MENU);
  assert.deepEqual(ai, input); // the AI's reply itself is not changed
  assert.deepEqual(checked.mentionedPrices, []);
  const rows = toRows([checked], MENU);
  assert.equal(rows[0].unclear, false);
  assert.equal(rows[0].unitPrice, "12.00");
  assert.equal(groupByBuyer(rows)[0].total, "24.00");
});

test("a price the BUYER wrote is still checked, next to the seller's", () => {
  const chat = splitMessages("[1/11 9:00 AM] Ali: 2 latte, RM20 right?\n[1/11 9:01 AM] Cafe: RM24 sorry", CHAT);
  const ai = order({ sourceMsgs: [1, 2], mentionedPrices: [{ text: "RM20", itemId: "latte", msg: 1 }, { text: "RM24", itemId: "latte", msg: 2 }] });
  const [checked] = checkOrders([ai], chat, MENU);
  assert.deepEqual(checked.mentionedPrices.map((p) => p.text), ["RM20"]);
  assert.match(toRows([checked], MENU)[0].reason, /buyer mentioned RM.20\.00, menu says RM.24\.00\./);
});

test("with no sellerName nothing is removed, and two arguments still work", () => {
  const noSeller = { ...MENU, sellerName: undefined };
  assert.equal(checkOrders([order({ buyer: "Cafe", sourceMsgs: [2] })], messages, noSeller).length, 1);
  assert.equal(checkOrders([order({ buyer: "Cafe", sourceMsgs: [2] })], messages).length, 1);
});

test("Read without AI: the seller's messages make no buyer and add nothing to anyone's order", () => {
  const orders = fallbackParse(messages, MENU);
  assert.deepEqual(orders.map((o) => o.buyer), ["Ali"]);
  assert.deepEqual(orders[0].sourceMsgs, [1, 3]);
  assert.deepEqual(orders[0].mentionedPrices, []);
  assert.deepEqual(orders[0].items, [{ itemId: "latte", qty: 2 }]);
});

test("Copy question: the seller's words are not the buyer's, so a seller's 'cancel' changes nothing", () => {
  const chat = "[1/11 9:00 AM] Ali: 2 latte\n[1/11 9:01 AM] Cafe: ok, tell me if you want to cancel";
  const [row] = toRows([order({ sourceMsgs: [1, 2], unclear: true, reason: "Which day?" })], MENU);
  const [{ question }] = buyerMessages([row], { text: chat, chatDate: CHAT }, MENU);
  assert.doesNotMatch(question, /still like your order/);
  assert.match(question, /your order is 2 x Latte/);
});

test("the accuracy report scores what the app would show, and names an order it removed", () => {
  const reply = { candidates: [{ content: { parts: [{ text: JSON.stringify({ orders: [order(), order({ buyer: "Cafe", sourceMsgs: [2] })] }) }] } }] };
  const result = scoreReply({ raw: JSON.stringify(reply), expected: { orders: [order()] }, menu: MENU, text: PASTE, chatDate: CHAT });
  assert.equal(result.perfect, true);
  assert.deepEqual(result.problems, ["Cafe: removed, this order came only from the seller's messages."]);
  assert.deepEqual(result.totals, { ready: 1, total: "24.00", needsCheck: 0 });
});

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

test("POST /api/parse: an AI order in the seller's name never reaches the table, and a seller price makes no check", async () => {
  const seller = DEMO_MENU.sellerName;
  const text = `[1/11 9:00 AM] Lina: 1 jar cookies\n[1/11 9:05 AM] ${seller}: ok, RM99 for you`;
  const orders = [
    { ...order({ buyer: "Lina", sourceMsgs: [1, 2], items: [{ itemId: "cookies", qty: 1 }], deliveryDate: null }), mentionedPrices: [{ text: "RM99", itemId: "cookies", msg: 2 }] },
    order({ buyer: seller, sourceMsgs: [2], items: [{ itemId: "cookies", qty: 1 }], deliveryDate: null }),
  ];
  const ai = { async parse() { return { orders, from: "fake" }; }, callsLeft: () => 40 };
  const { dir: visitorsDir, fetch } = testVisitor();
  const server = createApp(loadConfig({}), { log: () => {}, visitorsDir, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const post = (extra) => fetch(`http://localhost:${server.address().port}/api/parse`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, chatDate: CHAT, ...extra }),
  }).then((res) => res.json());

  for (const body of [await post({}), await post({ withoutAi: true })]) {
    assert.deepEqual(body.orders.map((row) => row.buyer), ["Lina"]);
    assert.equal(body.orders[0].unitPrice, "25.00");
    assert.equal(body.orders[0].unclear, false);
  }
});
