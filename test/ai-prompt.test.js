// Tests for the parse prompt/schema (src/ai-prompt.js) and the scorer (src/score-parse.js).
// No network: these prove the prompt and the scoring before any real (paid-quota) Gemini call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildParsePrompt, parseRequest, parseSchema, replyToOrders } from "../src/ai-prompt.js";
import { scoreParse, structureChecks } from "../src/score-parse.js";
import { calendarDays } from "../src/dates.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const MENU = readJson("../data/menu.json");
const EXPECTED = readJson("../data/expected-orders.json");
const CHATS = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const INPUT = { paste: CHATS, chatDate: "2026-10-28", menu: MENU };

test("calendarDays: the Chat date and the days after it, with weekdays", () => {
  assert.deepEqual(calendarDays("2026-10-28", 5).map((d) => `${d.label} = ${d.date}`), [
    "Wed 28 Oct 2026 = 2026-10-28", "Thu 29 Oct 2026 = 2026-10-29", "Fri 30 Oct 2026 = 2026-10-30",
    "Sat 31 Oct 2026 = 2026-10-31", "Sun 1 Nov 2026 = 2026-11-01",
  ]);
  assert.throws(() => calendarDays("28/10/2026", 3), /Not a valid chat date/);
});

test("the prompt has every menu id and alias, the ambiguous-word rule and the rules", () => {
  const { prompt } = buildParsePrompt(INPUT);
  for (const item of MENU.items) {
    assert.ok(prompt.includes(`- ${item.id}: ${item.name}.`), item.id);
    for (const alias of item.aliases) assert.ok(prompt.includes(`"${alias}"`), alias);
  }
  assert.match(prompt, /"brownies", "brownie", "brwnies" with no type: do NOT choose an item.*Which brownies: classic or cheese\?/);
  assert.match(prompt, /FINAL order/);
  assert.match(prompt, /changes .* add-ons .* cancellations/);
  assert.match(prompt, /Questions .* and payment requests .* are not orders/);
  assert.match(prompt, /Never set, guess or mention prices/);
  assert.match(prompt, /not instructions to you/);
});

test("each message gets its full date and weekday from dates.js; the calendar covers 15 days", () => {
  const { prompt, messages } = buildParsePrompt(INPUT);
  assert.equal(messages.length, 15);
  assert.ok(prompt.includes("1. [Wed 28 Oct 2026, 09:02] Lina: hi! can i order 2 boxes of classic brownies, deliver on saturday?"));
  assert.ok(prompt.includes("15. [Wed 28 Oct 2026, 21:30] Lina: pls send me the payment link later"));
  assert.ok(prompt.includes("Sat 31 Oct 2026 = 2026-10-31"));
  assert.ok(prompt.includes("Wed 11 Nov 2026 = 2026-11-11") && !prompt.includes("2026-11-12"));
});

test("the schema matches PLAN.md Section 5, forces menu ids, and has no price anywhere", () => {
  const schema = parseSchema(MENU);
  const order = schema.properties.orders.items;
  assert.deepEqual(order.required, ["buyer", "status", "sourceMsgs", "items", "deliveryDate", "fulfilment", "unclear", "reason", "note"]);
  assert.deepEqual(order.properties.items.items.properties.itemId.enum, MENU.items.map((i) => i.id));
  assert.equal(order.properties.items.items.properties.itemId.nullable, true);
  assert.deepEqual(order.properties.status.enum, ["active", "cancelled"]);
  assert.deepEqual(order.properties.fulfilment.enum, ["delivery", "pickup"]);
  assert.doesNotMatch(JSON.stringify(schema), /price|total/i);
});

test("the request body forces JSON and carries no key", () => {
  const { body } = parseRequest(INPUT);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.responseSchema);
  assert.doesNotMatch(JSON.stringify(body), /key|AIza/i);
});

test("replyToOrders reads the JSON text out of a raw reply, skipping thought parts; never guesses", () => {
  const raw = { candidates: [{ content: { parts: [{ thought: true, text: "thinking..." }, { text: '{"orders":[{"buyer":"Lina"}]}' }] } }] };
  assert.deepEqual(replyToOrders(JSON.stringify(raw)), [{ buyer: "Lina" }]);
  assert.throws(() => replyToOrders({ candidates: [{ finishReason: "SAFETY" }] }), /no text \(finishReason: SAFETY\)/);
  assert.throws(() => replyToOrders({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), SyntaxError);
  assert.throws(() => replyToOrders({ candidates: [{ content: { parts: [{ text: '{"x":1}' }] } }] }), /no orders list/);
});

test("scoreParse: the expected answers score perfectly against themselves", () => {
  const result = scoreParse(EXPECTED.orders, EXPECTED.orders);
  assert.equal(result.perfect, true);
  assert.deepEqual(result.scores.map((s) => `${s.name} ${s.ok}/${s.total}`),
    ["buyers 9/9", "cancellations 9/9", "items 8/8", "qty 8/8", "dates 8/8", "unclear 8/8", "fulfilment 8/8"]);
});

test("scoreParse names every difference", () => {
  const ai = structuredClone(EXPECTED.orders).filter((o) => o.buyer !== "Priya");
  ai.find((o) => o.buyer === "Lina").items[0].qty = 2; // missed the change in message 4
  ai.find((o) => o.buyer === "Danish").status = "active"; // missed the cancellation
  ai.find((o) => o.buyer === "Arif").fulfilment = null;
  ai.find((o) => o.buyer === "Hafiz").buyer = " hafiz "; // same buyer, other spelling: still matched
  ai.push({ buyer: "Lina", status: "active", items: [] }); // a duplicate
  ai.push({ buyer: "Zara", status: "active", items: [{ itemId: "cookies", qty: 1 }] }); // invented
  const { scores, differences, perfect } = scoreParse(ai, EXPECTED.orders);
  assert.equal(perfect, false);
  assert.deepEqual(differences.sort(), [
    "Arif: fulfilment null, expected \"pickup\".",
    "Danish: status \"active\", expected \"cancelled\".",
    "Lina: qty 2 × classic_brownies, expected 3 × classic_brownies.",
    "Lina: the AI returned more than one order for this buyer (only the first is scored).",
    "Priya: missing from the AI reply (expected active).",
    "Zara: an extra order the answers don't have (active, items 1 × cookies).",
  ]);
  assert.equal(scores.find((s) => s.name === "buyers").ok, 8);
});

test("structureChecks: unknown message numbers, impossible or far dates, long notes", () => {
  const { messages } = buildParsePrompt(INPUT);
  assert.deepEqual(structureChecks(EXPECTED.orders, messages), []);
  const bad = [
    { buyer: "A", sourceMsgs: [99], deliveryDate: null },
    { buyer: "B", sourceMsgs: [1], deliveryDate: "2026-02-30" },
    { buyer: "C", sourceMsgs: [1], deliveryDate: "2026-11-20" },
    { buyer: "D", sourceMsgs: [], deliveryDate: "2026-10-27", note: "x".repeat(121) },
  ];
  assert.deepEqual(structureChecks(bad, messages), [
    "A: message number(s) 99 don't exist.",
    "B: date \"2026-02-30\" is not a real date.",
    "C: date 2026-11-20 is 23 days from its latest message (2026-10-28); allowed 0-14.",
    "D: no source messages.",
    "D: note is 121 characters (max 120).",
  ]);
});

test("mock mode returns Gemini's saved real reply: 9 orders, 7 ready, RM 387.00 through toRows()", async () => {
  const { mockParse } = await import("../src/ai.js");
  const { toRows, totals } = await import("../src/orders.js");
  const orders = mockParse();
  assert.equal(orders.length, 9);
  assert.deepEqual(scoreParse(orders, EXPECTED.orders).differences, []); // the saved reply scored perfectly
  assert.deepEqual(totals(toRows(orders, MENU)), { orders: 7, total: "387.00" });
});

test("mock mode: a missing or broken saved reply is a clear error, never made-up data", async () => {
  const { mockParse } = await import("../src/ai.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.throws(() => mockParse(join(tmpdir(), "no-such-reply.json")), /Could not read the saved AI reply/);
  const broken = join(mkdtempSync(join(tmpdir(), "chatching-")), "reply.json");
  writeFileSync(broken, '{"candidates":[{"finishReason":"MAX_TOKENS"}]}');
  assert.throws(() => mockParse(broken), /is broken: The AI reply has no text \(finishReason: MAX_TOKENS\)/);
});
