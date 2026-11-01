// Tests for POST /api/invoices and batches (Step 5, Part 2): one invoice per clear buyer, never two,
// and once invoices exist, "Read orders" is refused until "New batch" (PLAN.md Step 5).
// PayPal is the FAKE in scripts/fake-paypal.mjs; each server has its own temporary visitor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal, NOT_CONFIGURED } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";
import { testVisitor } from "../scripts/test-visitor.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const CHAT = "2026-10-28";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";
const CLEAR_BUYERS = ["Lina", "Hafiz", "Mei Ling", "Aisyah", "Arif", "Sarah", "Kak Ros"];

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS } = {}) {
  const fake = fakePayPal();
  const logs = [];
  const { dir: visitorsDir, fetch, file } = testVisitor();
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: (line) => logs.push(line), visitorsDir, paypal }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return {
    fake, logs, file, call,
    state: async () => (await call("/api/state")).body,
    send: (body = {}) => call("/api/invoices", "POST", body),
    parse: () => call("/api/parse", "POST", { text: DEMO, chatDate: CHAT }),
    newBatch: () => call("/api/new-batch", "POST", {}),
  };
}

const rowsOf = (state, buyer) => state.orders.filter((row) => row.buyer === buyer);

test("missing PayPal keys -> 503 \"PayPal is not configured\" (sent on purpose), nothing called, nothing changed", async () => {
  const app = await start({ env: {} });
  const before = await app.state();
  const { status, body } = await app.send();
  assert.equal(status, 503);
  assert.deepEqual(body, { error: NOT_CONFIGURED });
  assert.equal(app.fake.calls.length, 0);
  assert.deepEqual(await app.state(), before);
});

test("Send invoices: one invoice per CLEAR buyer (7), sent without email; Priya and Danish are not invoiced", async () => {
  const app = await start();
  const { batch } = await app.state();
  const { status, body } = await app.send();
  assert.equal(status, 200);
  assert.deepEqual(body.sent.map((s) => s.buyer), CLEAR_BUYERS);
  assert.deepEqual(body.skipped, [{ buyer: "Priya", reason: "Needs a check first." }, { buyer: "Jun Wei", reason: "Needs a check first." }]);
  assert.deepEqual(body.failed, []);
  assert.equal(app.fake.invoices.size, 7);
  assert.ok(app.fake.calls.filter((c) => c.kind === "send").every((c) => c.body.send_to_recipient === false && c.body.send_to_invoicer === false));

  // The rows remember the invoice: id, number by table position, payer link, status "Sent".
  const meiLing = rowsOf(body, "Mei Ling");
  assert.equal(meiLing.length, 2);
  assert.ok(meiLing.every((row) => row.invoiceId === meiLing[0].invoiceId && row.invoiceStatus === "Sent"));
  assert.equal(meiLing[0].invoiceNumber, `CHATCHING-${batch}-03`); // Mei Ling is the 3rd buyer in the table
  assert.match(meiLing[0].payerLink, /^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#INV2-/);
  assert.equal(app.fake.invoices.get(meiLing[0].invoiceId).amount.value, "72.00");
  for (const buyer of ["Priya", "Jun Wei", "Danish"]) assert.ok(rowsOf(body, buyer).every((row) => row.invoiceId === null), buyer);

  // Saved: a reload shows the same.
  assert.deepEqual((await app.state()).orders, body.orders);
});

test("clicking again creates NOTHING new: every buyer is already invoiced", async () => {
  const app = await start();
  await app.send();
  const creates = app.fake.count("create");
  const { body } = await app.send();
  assert.deepEqual(body.sent, []);
  // In table order: Priya and Jun Wei still need a check, everyone else already has an invoice.
  assert.deepEqual(body.skipped.map((s) => `${s.buyer}: ${s.reason}`), [
    "Lina: Already invoiced.", "Hafiz: Already invoiced.", "Mei Ling: Already invoiced.", "Aisyah: Already invoiced.", "Arif: Already invoiced.",
    "Priya: Needs a check first.", "Sarah: Already invoiced.", "Kak Ros: Already invoiced.", "Jun Wei: Needs a check first.",
  ]);
  assert.equal(app.fake.count("create"), creates);
  assert.equal(app.fake.invoices.size, 7);
});

test("two Send requests at the same moment (a double-click) still give ONE invoice per buyer", async () => {
  const app = await start();
  const release = app.fake.hold();
  const held = app.fake.waiting("create");
  const first = app.send();
  const second = app.send();
  await held; // the first send is really waiting for PayPal
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(app.fake.invoices.size, 7);
  assert.equal(a.body.sent.length + b.body.sent.length, 7);
  const numbers = [...app.fake.invoices.values()].map((inv) => inv.detail.invoice_number);
  assert.equal(new Set(numbers).size, 7);
});

test("the server refuses one buyer that is unclear, cancelled or unknown (not only the page)", async () => {
  const app = await start();
  assert.deepEqual(await app.send({ buyer: "Priya" }), { status: 400, body: { error: "Priya needs a check before invoicing." } });
  assert.deepEqual(await app.send({ buyer: "Danish" }), { status: 400, body: { error: "Danish's order is cancelled, so it can't be invoiced." } });
  assert.deepEqual(await app.send({ buyer: "Nobody" }), { status: 404, body: { error: "No buyer called \"Nobody\"." } });
  assert.equal((await app.send({ buyer: 42 })).status, 400);
  assert.equal(app.fake.count("create"), 0);
  const { body } = await app.send({ buyer: "lina" }); // one buyer, any spelling
  assert.deepEqual(body.sent.map((s) => s.buyer), ["Lina"]);
  assert.equal(app.fake.invoices.size, 1);
});

test("PayPal already has this invoice number (an earlier click that timed out) -> that invoice is reused, not doubled", async () => {
  const app = await start();
  const { batch } = await app.state();
  const id = app.fake.add({ status: "UNPAID", detail: { invoice_number: `CHATCHING-${batch}-01`, currency_code: "MYR" }, items: [{ name: "Classic brownies (box of 6)", quantity: "3", unit_amount: { currency_code: "MYR", value: "18.00" } }], amount: { currency_code: "MYR", value: "54.00" } });
  const { body } = await app.send();
  assert.equal(rowsOf(body, "Lina")[0].invoiceId, id);
  assert.equal(app.fake.invoices.size, 7); // Lina's old one + 6 new
  assert.equal(body.sent.find((s) => s.buyer === "Lina").reused, true);
});

test("a send that fails keeps the draft's id; the next click sends THAT draft, no new invoice", async () => {
  const app = await start();
  app.fake.failNext("send", 503, { name: "SERVICE_UNAVAILABLE", message: "Service unavailable." });
  const first = (await app.send()).body;
  assert.equal(first.failed.length, 1);
  const [failed] = first.failed;
  assert.equal(failed.buyer, "Lina");
  assert.match(failed.reason, /PayPal could not send invoice .* \(HTTP 503, SERVICE_UNAVAILABLE\)/);
  const lina = rowsOf(first, "Lina")[0];
  assert.ok(lina.invoiceId);
  assert.equal(lina.invoiceStatus, "Draft");
  assert.equal(first.sent.length, 6);

  const second = (await app.send()).body;
  assert.deepEqual(second.sent.map((s) => s.buyer), ["Lina"]);
  assert.equal(rowsOf(second, "Lina")[0].invoiceId, lina.invoiceId);
  assert.equal(rowsOf(second, "Lina")[0].invoiceStatus, "Sent");
  assert.equal(app.fake.invoices.size, 7);
});

test("no key or token ever reaches a reply or the server log", async () => {
  const app = await start();
  app.fake.failNext("create", 500, { name: "INTERNAL_SERVER_ERROR", message: "boom" });
  const { body } = await app.send();
  const text = JSON.stringify(body) + app.logs.join("\n") + JSON.stringify(await app.state());
  for (const secret of [...Object.values(FAKE_KEYS), "fake-token"]) assert.ok(!text.includes(secret), secret);
});

test("an invoiced row can't be edited (the invoice would no longer match)", async () => {
  const app = await start();
  await app.send({ buyer: "Lina" });
  const lina = rowsOf(await app.state(), "Lina")[0];
  const { status, body } = await app.call(`/api/orders/${lina.id}`, "PUT", { qty: 5 });
  assert.equal(status, 400);
  assert.equal(body.error, "Invoice sent: items are locked so the invoice and the table always match.");
});

// ---- Batches (PLAN.md Step 5, added 28 Oct) ----

test("after any invoice is sent, Read orders is refused (by the server) and the rows stay", async () => {
  const app = await start();
  await app.send({ buyer: "Lina" });
  const before = await app.state();
  const { status, body } = await app.parse();
  assert.equal(status, 200);
  assert.deepEqual(body, { notice: INVOICED });
  assert.deepEqual(await app.state(), before);
});

test("Read orders and New batch wait while invoices are being sent", async () => {
  const app = await start();
  const release = app.fake.hold();
  const held = app.fake.waiting("create");
  const sending = app.send();
  await held;
  assert.deepEqual((await app.parse()).body, { notice: "Invoices are being sent right now. Please wait for that to finish." });
  assert.deepEqual((await app.newBatch()).body, { notice: "Invoices are being sent right now. Please wait for that to finish." });
  release();
  await sending;
});

test("New batch saves the old batch (rows + invoice links) and starts an empty one that can be read", async () => {
  const app = await start();
  const sent = (await app.send()).body;
  const oldBatch = sent.batch;
  const { status, body } = await app.newBatch();
  assert.equal(status, 200);
  assert.deepEqual([body.orders, body.groups, body.source], [[], [], null]);
  assert.deepEqual(body.summary, { orders: 0, ready: 0, expected: "0.00", paidOrders: 0, paid: "0.00", needsCheck: 0 });
  assert.match(body.batch, /^[A-Z0-9]{12}$/);
  assert.notEqual(body.batch, oldBatch);

  // The old batch is kept in the visitor's file, with every invoice link.
  const { batches } = JSON.parse(readFileSync(app.file, "utf8"));
  assert.equal(batches.length, 1);
  const [saved] = batches;
  assert.equal(saved.batch, oldBatch);
  assert.deepEqual(saved.rows, sent.orders);
  assert.equal(saved.rows.filter((row) => row.payerLink).length, 8); // 12 rows minus Priya's, Danish's and Jun Wei's 2
  assert.equal(saved.source.messages, 18);

  // No buyer of the old batch is invoiced again: the new batch is empty.
  const creates = app.fake.count("create");
  const again = (await app.send()).body;
  assert.deepEqual([again.sent, again.skipped, again.failed], [[], [], []]);
  assert.equal(app.fake.count("create"), creates);

  // The new batch can be read (reading gives it a fresh id again), and its invoices use that id.
  const read = (await app.parse()).body;
  assert.equal(read.groups.length, 10);
  assert.notEqual(read.batch, oldBatch);
  // Arif already has an invoice from the old batch today, so he needs "Send anyway" first (the 1 Nov review, #1).
  assert.equal((await app.send({ buyer: "Arif" })).status, 400);
  await app.call(`/api/buyers/${rowsOf(read, "Arif")[0].id}/send-anyway`, "POST", {});
  const fresh = (await app.send({ buyer: "Arif" })).body;
  assert.equal(rowsOf(fresh, "Arif")[0].invoiceNumber, `CHATCHING-${read.batch}-05`); // Arif is the 5th buyer
});

test("every parse starts a new batch id (so invoice numbers never repeat across reads)", async () => {
  const app = await start();
  const first = (await app.state()).batch;
  const read = (await app.parse()).body;
  assert.match(read.batch, /^[A-Z0-9]{12}$/);
  assert.notEqual(read.batch, first);
  assert.deepEqual(JSON.parse(readFileSync(app.file, "utf8")).batches, []); // nothing invoiced, so nothing to keep
});
