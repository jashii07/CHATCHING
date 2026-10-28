// Tests for src/validate.js: our checks on the AI's orders against the pasted messages (PLAN.md Section 5).
// A problem never drops an order: it becomes unclear with a reason, and toRows() shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkOrders, MAX_NOTE } from "../src/validate.js";
import { toRows } from "../src/orders.js";
import { splitMessages } from "../src/dates.js";
import { mockParse } from "../src/ai.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const CHAT = "2026-10-28";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const messages = splitMessages(DEMO, CHAT); // 15 messages, all on Wed 28 Oct 2026
const order = (extra = {}) => ({
  buyer: "Lina", status: "active", sourceMsgs: [1], items: [{ itemId: "cookies", qty: 1 }],
  deliveryDate: "2026-10-31", fulfilment: "delivery", unclear: false, reason: "", note: "", ...extra,
});
const one = (extra, msgs = messages) => checkOrders([order(extra)], msgs)[0];

test("Gemini's real demo reply passes every check unchanged: 7 clear orders, RM 387.00, only Priya unclear", () => {
  const ai = mockParse();
  const checked = checkOrders(ai, messages);
  assert.deepEqual(checked, ai);
  const rows = toRows(checked, menu);
  assert.deepEqual([...new Set(rows.filter((r) => r.unclear).map((r) => r.buyer))], ["Priya"]);
});

test("a clear order stays clear, and the input is not changed", () => {
  const input = [order()];
  const copy = structuredClone(input);
  assert.deepEqual(checkOrders(input, messages), input);
  assert.deepEqual(input, copy);
});

test("a message number that doesn't exist -> unclear, naming it; the real numbers are kept", () => {
  const checked = one({ sourceMsgs: [1, 99, 0] });
  assert.equal(checked.unclear, true);
  assert.match(checked.reason, /Message 99, 0 is not in the chat \(it has 15 messages\)\./);
  assert.deepEqual(checked.sourceMsgs, [1]);
});

test("no message numbers at all (missing, empty, not a list) -> unclear", () => {
  for (const sourceMsgs of [undefined, null, [], "1", [1.5]]) {
    const checked = one({ sourceMsgs });
    assert.equal(checked.unclear, true, JSON.stringify(sourceMsgs));
    assert.ok(Array.isArray(checked.sourceMsgs));
  }
});

test("a delivery date that is not a real date -> unclear", () => {
  for (const deliveryDate of ["2026-02-30", "tomorrow", "31/10", 5]) {
    const checked = one({ deliveryDate });
    assert.equal(checked.unclear, true, String(deliveryDate));
    assert.match(checked.reason, /not a real date/);
  }
});

test("a delivery date before its message, or more than 14 days after -> unclear; 0 and 14 days are fine", () => {
  assert.equal(one({ deliveryDate: "2026-10-28" }).unclear, false);
  assert.equal(one({ deliveryDate: "2026-11-11" }).unclear, false);
  assert.match(one({ deliveryDate: "2026-10-27" }).reason, /Tue 27 Oct 2026 is before message 1 \(Wed 28 Oct 2026\)/);
  assert.match(one({ deliveryDate: "2026-11-12" }).reason, /Thu 12 Nov 2026 is more than 14 days after message 1/);
});

test("the 14 days count from the LATEST source message, the 'before' check from the earliest", () => {
  const msgs = splitMessages("[20/10 9:00 AM] Lina: 1 cookies\n[28/10 9:00 AM] Lina: deliver 10 Nov", CHAT);
  assert.equal(one({ sourceMsgs: [1, 2], deliveryDate: "2026-11-10" }, msgs).unclear, false);
  assert.equal(one({ sourceMsgs: [1, 2], deliveryDate: "2026-10-20" }, msgs).unclear, false);
  assert.equal(one({ sourceMsgs: [1, 2], deliveryDate: "2026-10-19" }, msgs).unclear, true);
});

test("a source message with an impossible timestamp -> unclear with its reason", () => {
  const msgs = splitMessages("[29/2 9:00 AM] Lina: 1 cookies", "2027-03-01");
  const checked = one({ deliveryDate: null }, msgs);
  assert.equal(checked.unclear, true);
  assert.match(checked.reason, /Message 1: There is no 29\/2 in 2027/);
});

test("a source message far from the Chat date -> unclear with \"Check the Chat date\"", () => {
  const msgs = splitMessages("[15/7 9:00 AM] Lina: 1 cookies", CHAT);
  const checked = one({ deliveryDate: null }, msgs);
  assert.equal(checked.unclear, true);
  assert.match(checked.reason, /Message 1 is dated Wed 15 Jul 2026: Check the Chat date\./);
});

test("an unknown status or fulfilment -> unclear (never guessed); a bad status is NOT treated as cancelled", () => {
  const status = one({ status: "CANCELLED" });
  assert.equal(status.unclear, true);
  assert.match(status.reason, /Unknown order status "CANCELLED"/);
  assert.equal(toRows([status], menu)[0].orderStatus, "active"); // shown, so the seller decides
  assert.match(one({ fulfilment: "courier" }).reason, /Unknown pickup or delivery "courier"/);
  assert.equal(one({ fulfilment: undefined }).unclear, false); // missing = not said
});

test("the AI's own reason comes first; an AI flag with no reason still says the AI flagged it", () => {
  assert.match(one({ unclear: true, reason: "Which brownies?", sourceMsgs: [99] }).reason, /^Which brownies\? Message 99/);
  assert.match(one({ unclear: true, reason: "", sourceMsgs: [99] }).reason, /^The AI marked this order unclear\. Message 99/);
});

test(`a note longer than ${MAX_NOTE} characters is cut to ${MAX_NOTE} (not a problem); a non-text note becomes ""`, () => {
  const long = one({ note: "x".repeat(300) });
  assert.equal(long.unclear, false);
  assert.equal(long.note.length, MAX_NOTE);
  assert.ok(long.note.endsWith("…"));
  assert.equal(one({ note: { x: 1 } }).note, "");
});

test("broken entries never crash and are never dropped (toRows makes them unclear)", () => {
  const input = [null, undefined, 42, "x", {}, order()];
  const checked = checkOrders(input, messages);
  assert.equal(checked.length, input.length);
  const rows = toRows(checked, menu);
  assert.equal(rows.length, input.length);
  assert.deepEqual(rows.map((r) => r.unclear), [true, true, true, true, true, false]);
});

test("checkOrders(not a list) throws a clear error (the route turns it into a notice)", () => {
  assert.throws(() => checkOrders({ orders: [] }, messages), /aiOrders must be an array/);
});
