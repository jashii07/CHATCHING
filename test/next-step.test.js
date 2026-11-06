// The step guide's "what to do next" line (user test, 6 Nov: my friend didn't know what to do in which order,
// or that each buyer needs their message). public/next-step.js works it out from the table; the page shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEXT_TEXT, nextStep, waitingForMessage } from "../public/next-step.js";

// A buyer as the page builds it (buyerRows in public/app.js), with the fields the guide looks at.
const buyer = (key, fields = {}) => ({ key, cancelled: false, unclear: false, toSend: false, payerLink: null, status: "Not sent", collected: false, answer: null, ...fields });
const clear = (key) => buyer(key, { toSend: true });
const amber = (key) => buyer(key, { unclear: true });
const sent = (key, fields = {}) => buyer(key, { payerLink: `https://pay/${key}`, status: "Sent", ...fields });
const paid = (key, fields = {}) => sent(key, { status: "Paid", ...fields });
const done = (...items) => new Set(items);

// The demo right after Read orders: 7 clear orders, Priya and Jun Wei to check, Danish cancelled.
const demoRead = () => [clear("lina"), clear("hafiz"), amber("priya"), clear("aisyah"), clear("arif"), buyer("danish", { cancelled: true }), amber("jun wei"), clear("mei ling"), clear("kak ros"), clear("siti")];

test("(a) an empty table: try the demo or paste chats, then Read orders", () => {
  assert.deepEqual(nextStep([]), { key: "start", text: NEXT_TEXT.start, buyer: null });
  assert.match(NEXT_TEXT.start, /Try the demo/);
  assert.match(NEXT_TEXT.start, /Read orders/);
});

test("(b) amber rows first: fix them, and Copy question asks the buyer; it points at the first one not asked yet", () => {
  assert.deepEqual(nextStep(demoRead()), { key: "fix", text: NEXT_TEXT.fix, buyer: "priya" });
  assert.match(NEXT_TEXT.fix, /amber rows/);
  assert.match(NEXT_TEXT.fix, /Copy question/);
  assert.equal(nextStep(demoRead(), done("question:priya")).buyer, "jun wei");
});

test("(c) once every amber buyer was asked, or nothing is amber: send the invoices", () => {
  assert.deepEqual(nextStep(demoRead(), done("question:priya", "question:jun wei")), { key: "send", text: NEXT_TEXT.send, buyer: null });
  assert.equal(nextStep([clear("lina"), clear("hafiz")]).key, "send");
  assert.match(NEXT_TEXT.send, /Send invoices|send the invoices/i);
});

test("(d) after sending: send each buyer their message, starting with the first one not sent yet", () => {
  const table = [sent("lina"), sent("hafiz"), amber("priya")];
  assert.deepEqual(nextStep(table), { key: "message", text: NEXT_TEXT.message, buyer: "lina" });
  assert.equal(nextStep(table, done("message:lina")).buyer, "hafiz");
  for (const words of ["Copy message", "paste it into your chat", "order page", "Pay button", "QR code"]) assert.ok(NEXT_TEXT.message.includes(words), words);
});

test("(d) a buyer counts as messaged once the message was copied, or they answered on their page, or paid", () => {
  const table = [sent("lina", { answer: { answer: "ok" } }), paid("hafiz"), sent("arif"), sent("siti")];
  assert.deepEqual(waitingForMessage(table, done("message:arif")).map((b) => b.key), ["siti"]);
  assert.deepEqual(waitingForMessage(table, done("message:arif", "message:siti")), []);
  // Part paid is still waiting for money, but the buyer clearly has the page.
  assert.deepEqual(waitingForMessage([sent("lina", { status: "Part paid" })]).map((b) => b.key), ["lina"]);
});

test("a failed or new invoice to send comes before the messages", () => {
  assert.equal(nextStep([sent("lina"), clear("arif")]).key, "send");
});

test("after the messages: an amber buyer not asked yet comes before waiting for money", () => {
  const table = [sent("lina"), amber("priya")];
  assert.equal(nextStep(table, done("message:lina")).key, "fix");
  assert.equal(nextStep(table, done("message:lina", "question:priya")).key, "watch");
});

test("(e) invoices out and every buyer messaged: watch for Paid (Refresh status) or record cash", () => {
  const table = [sent("lina"), paid("hafiz"), sent("arif", { status: "Part paid" })];
  assert.deepEqual(nextStep(table, done("message:lina", "message:arif")), { key: "watch", text: NEXT_TEXT.watch, buyer: null });
  assert.match(NEXT_TEXT.watch, /Paid/);
  assert.match(NEXT_TEXT.watch, /Refresh status/);
  assert.match(NEXT_TEXT.watch, /cash/);
});

test("(f) everything paid but not handed over: Pickup scan, then Collected", () => {
  const table = [paid("lina"), paid("hafiz", { status: "Paid (cash/bank)", collected: true })];
  assert.deepEqual(nextStep(table), { key: "pickup", text: NEXT_TEXT.pickup, buyer: null });
  assert.match(NEXT_TEXT.pickup, /Pickup scan/);
  assert.match(NEXT_TEXT.pickup, /Collected/);
});

test("all paid and handed over: amber buyers still waiting for an answer, then a New batch", () => {
  assert.equal(nextStep([paid("lina", { collected: true }), amber("priya")], done("question:priya")).key, "fix");
  assert.deepEqual(nextStep([paid("lina", { collected: true }), buyer("danish", { cancelled: true })]), { key: "done", text: NEXT_TEXT.done, buyer: null });
  assert.match(NEXT_TEXT.done, /New batch/);
});

test("a refunded or cancelled invoice is neither waiting for money nor for pickup", () => {
  assert.equal(nextStep([sent("lina", { status: "Cancelled/Refunded" }), paid("hafiz", { collected: true })], done("message:lina")).key, "done");
});

test("every order cancelled and nothing sent: paste new chats", () => {
  assert.deepEqual(nextStep([buyer("danish", { cancelled: true })]), { key: "nothing", text: NEXT_TEXT.nothing, buyer: null });
});

test("a cancelled buyer never needs a check, an invoice or a message", () => {
  const table = [buyer("danish", { cancelled: true, unclear: true, toSend: true }), paid("lina", { collected: true })];
  assert.equal(nextStep(table).key, "done");
  assert.deepEqual(waitingForMessage([sent("danish", { cancelled: true })]), []);
});

test("each line is short, plain and says no 'we'", () => {
  for (const [key, text] of Object.entries(NEXT_TEXT)) {
    assert.ok(text.length <= 170, `${key} is ${text.length} characters`);
    assert.doesNotMatch(text, /\b(we|our|us)\b/i, key);
  }
});
