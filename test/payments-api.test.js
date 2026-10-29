// Tests for POST /api/invoices/:id/payment (Step 6, Part 2): record a cash or bank-transfer payment in
// PayPal for the FULL invoice total, taken from the saved invoice (never typed, never from the AI).
// Recording twice is refused by the server. PayPal is the FAKE in scripts/fake-paypal.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal, NOT_CONFIGURED } from "../src/paypal.js";
import { createStatusChecker } from "../src/status.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const ALREADY = (buyer) => `${buyer}'s invoice is already paid, so nothing was recorded.`;

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS } = {}) {
  const fake = fakePayPal();
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json");
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, storeFile, paypal, now: () => Date.UTC(2026, 9, 28, 20, 0) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const app = {
    fake, call,
    state: async () => (await call("/api/state")).body,
    send: () => call("/api/invoices", "POST", {}),
    record: (id, body) => call(`/api/invoices/${encodeURIComponent(id)}/payment`, "POST", body),
  };
  app.sent = env === FAKE_KEYS ? (await app.send()).body : null;
  return app;
}

const rowsOf = (state, buyer) => state.orders.filter((row) => row.buyer === buyer);
const idOf = (state, buyer) => rowsOf(state, buyer)[0].invoiceId;
const payments = (fake) => fake.calls.filter((c) => c.kind === "payment");

test("missing PayPal keys -> 503 \"PayPal is not configured\"", async () => {
  const app = await start({ env: {} });
  assert.deepEqual(await app.record("INV2-ANY", { method: "CASH" }), { status: 503, body: { error: NOT_CONFIGURED } });
  assert.equal(app.fake.calls.length, 0);
});

test("record cash for Lina: PayPal gets the FULL invoice total; the row becomes Paid (cash/bank)", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  const { status, body } = await app.record(id, { method: "CASH" });
  assert.equal(status, 200);
  assert.deepEqual(body.recorded, { buyer: "Lina", method: "CASH", amount: "54.00" });
  const [call] = payments(app.fake);
  assert.deepEqual(call.body, {
    method: "CASH", payment_date: "2026-10-28", amount: { currency_code: "MYR", value: "54.00" },
    note: "Cash recorded in ChatChing.",
  });
  assert.equal(app.fake.invoices.get(id).status, "MARKED_AS_PAID");
  assert.ok(rowsOf(body, "Lina").every((row) => row.invoiceStatus === "Paid (cash/bank)"));
  assert.deepEqual([body.summary.paidOrders, body.summary.paid], [1, "54.00"]);
  assert.deepEqual((await app.state()).orders, body.orders); // saved
});

test("bank transfer for Hafiz (2 rows, one invoice): 70.00, both rows paid", async () => {
  const app = await start();
  const { body } = await app.record(idOf(app.sent, "Hafiz"), { method: "BANK_TRANSFER" });
  assert.deepEqual(body.recorded, { buyer: "Hafiz", method: "BANK_TRANSFER", amount: "70.00" });
  assert.equal(payments(app.fake)[0].body.note, "Bank transfer recorded in ChatChing.");
  assert.deepEqual(rowsOf(body, "Hafiz").map((row) => row.invoiceStatus), ["Paid (cash/bank)", "Paid (cash/bank)"]);
});

test("recording twice is refused by the server: 409, no second payment at PayPal", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  await app.record(id, { method: "CASH" });
  assert.deepEqual(await app.record(id, { method: "CASH" }), { status: 409, body: { error: ALREADY("Lina") } });
  assert.equal(payments(app.fake).length, 1);
});

test("two clicks at the same moment: one payment is recorded, the other is refused", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  const release = app.fake.hold("payment");
  const held = app.fake.waiting("payment");
  const first = app.record(id, { method: "CASH" });
  await held; // the first click is really waiting for PayPal
  const second = await app.record(id, { method: "CASH" });
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(second, { status: 409, body: { error: "Lina's payment is being recorded right now." } });
  assert.equal(payments(app.fake).length, 1);
});

test("the buyer already paid by PayPal (our page didn't know yet) -> refused, and the status is saved as Paid", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  app.fake.pay(id);
  assert.deepEqual(await app.record(id, { method: "CASH" }), { status: 409, body: { error: ALREADY("Lina") } });
  assert.equal(payments(app.fake).length, 0);
  assert.ok(rowsOf(await app.state(), "Lina").every((row) => row.invoiceStatus === "Paid"));
});

test("the amount is never sent by the page: a body with an amount, or a bad method, is refused", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  assert.deepEqual(await app.record(id, { method: "CASH", amount: "1.00" }),
    { status: 400, body: { error: "Send only the method: the amount always comes from the invoice." } });
  for (const body of [{ method: "PAYPAL" }, { method: "cash" }, {}, { method: 1 }]) {
    assert.deepEqual(await app.record(id, body), { status: 400, body: { error: 'Send { "method": "CASH" } or { "method": "BANK_TRANSFER" }.' } });
  }
  assert.equal(payments(app.fake).length, 0);
});

test("refused: an unknown invoice, a draft that was never sent, part paid, cancelled", async () => {
  const app = await start();
  assert.deepEqual(await app.record("INV2-NOPE", { method: "CASH" }), { status: 404, body: { error: 'No invoice "INV2-NOPE" in these orders.' } });

  const draftApp = await start({ env: FAKE_KEYS });
  const lina = idOf(draftApp.sent, "Lina");
  draftApp.fake.pay(idOf(draftApp.sent, "Hafiz"), "PARTIALLY_PAID");
  draftApp.fake.pay(idOf(draftApp.sent, "Arif"), "CANCELLED");
  assert.deepEqual(await draftApp.record(idOf(draftApp.sent, "Hafiz"), { method: "CASH" }),
    { status: 409, body: { error: "Hafiz has paid part of the invoice. Record the rest in PayPal itself." } });
  assert.deepEqual(await draftApp.record(idOf(draftApp.sent, "Arif"), { method: "CASH" }),
    { status: 409, body: { error: "Arif's invoice is cancelled at PayPal, so nothing was recorded." } });
  assert.equal(payments(draftApp.fake).length, 0);
  assert.ok(lina);
});

test("PayPal's saved total differs from the menu's -> refused, nothing recorded (check first, charge second)", async () => {
  const app = await start();
  const id = idOf(app.sent, "Lina");
  app.fake.invoices.get(id).amount.value = "50.00";
  assert.deepEqual(await app.record(id, { method: "CASH" }),
    { status: 409, body: { error: "PayPal's total for Lina (50.00 MYR) is not the menu's (54.00 MYR), so nothing was recorded." } });
  assert.equal(payments(app.fake).length, 0);
});

test("a status check that started before a cash payment never turns it back to Sent", async () => {
  let rows = [{ id: "r1", buyer: "Lina", invoiceId: "INV2-1", invoiceStatus: "Sent" }];
  const store = {
    batch: () => "AAAAAAAA",
    rows: () => rows,
    replaceMany: (updated) => (rows = rows.map((row) => updated.find((u) => u.id === row.id) ?? row)),
  };
  const paypal = {
    async getInvoice() {
      rows = [{ ...rows[0], invoiceStatus: "Paid (cash/bank)" }]; // the cash payment lands while we wait
      return { status: "UNPAID" }; // PayPal's answer from before the payment
    },
  };
  const result = await createStatusChecker({ store, paypal, now: () => 0 }).refresh();
  assert.deepEqual(result.changed, []);
  assert.equal(rows[0].invoiceStatus, "Paid (cash/bank)");
});
