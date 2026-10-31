// Tests for the pickup scan's server side (Step 10c, Part 2): POST /api/pickup/check and /api/pickup/collected.
// PayPal is the FAKE in scripts/fake-paypal.mjs; the clock is ours, so no test waits 10 real seconds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal, NOT_CONFIGURED } from "../src/paypal.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { CACHE_MS } from "../src/status.js";
import { NOT_IN_ORDERS } from "../src/pickup.js";
import { NOT_OUR_QR } from "../public/invoice-qr.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";
import { testVisitor } from "../scripts/test-visitor.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const JSON_HEADERS = { "Content-Type": "application/json" };

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS, visitor = testVisitor(), fake = fakePayPal(), limits } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, visitorsDir: visitor.dir, paypal, now, ...(limits && { limiter: createRateLimiter({ limits, now }) }) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const callAs = (who) => async (path, method = "GET", body) => {
    const res = await who.fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const call = callAs(visitor);
  const app = {
    fake, call, callAs, visitor,
    tick: (ms) => (clock += ms),
    state: async () => (await call("/api/state")).body,
    send: () => call("/api/invoices", "POST", {}),
    check: (invoiceId) => call("/api/pickup/check", "POST", { invoiceId }),
    collected: (invoiceId, extra = {}) => call("/api/pickup/collected", "POST", { invoiceId, ...extra }),
    rowsOf: async (buyer) => (await app.state()).orders.filter((row) => row.buyer === buyer),
    invoiceOf: async (buyer) => (await app.rowsOf(buyer))[0].invoiceId,
  };
  return app;
}

// Invoices sent, and the 10-second cache from sending has run out.
async function sent(options) {
  const app = await start(options);
  await app.send();
  app.tick(CACHE_MS);
  return app;
}

const gets = (fake) => fake.calls.filter((c) => c.kind === "get" && c.method === "GET").length;
const justThePickup = ({ invoiceId, invoiceNumber, buyer, items, total, status, paid, state, title, detail, collected, cached }) =>
  ({ invoiceId, invoiceNumber, buyer, items, total, status, paid, state, title, detail, collected, cached });

test("a paid invoice: buyer, items, total and paid, with the big green words", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  const [row] = await app.rowsOf("Lina");
  app.fake.pay(id);
  const { status, body } = await app.check(id);
  assert.equal(status, 200);
  assert.deepEqual(justThePickup(body), {
    invoiceId: id, invoiceNumber: row.invoiceNumber, buyer: "Lina",
    items: [{ qty: 3, name: "Classic brownies" }], total: "54.00",
    status: "Paid", paid: true, state: "paid",
    title: "Paid: Lina, 3 x Classic brownies", detail: "Lina, 3 x Classic brownies",
    collected: false, cached: false,
  });
  assert.equal((await app.rowsOf("Lina"))[0].invoiceStatus, "Paid", "the live answer is saved in the table too");
  assert.deepEqual(body.changed, [{ buyer: "Lina", from: "Sent", to: "Paid" }]);
  assert.equal(body.summary.paidOrders, 1, "the reply carries the table, so the page updates");
});

test("an unpaid invoice: the big amber words with the amount", async () => {
  const app = await sent();
  const { body } = await app.check(await app.invoiceOf("Lina"));
  assert.equal(body.paid, false);
  assert.equal(body.state, "unpaid");
  assert.equal(body.status, "Sent");
  assert.equal(body.title, "Not paid yet: RM 54.00");
  assert.equal(body.detail, "Lina, 3 x Classic brownies");
});

test("a buyer with two items: both are named and the total is the whole invoice", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Mei Ling");
  app.fake.pay(id);
  const { body } = await app.check(id);
  assert.deepEqual(body.items, [{ qty: 1, name: "Cheese brownies" }, { qty: 2, name: "Choc chip cookies" }]);
  assert.equal(body.total, "72.00");
  assert.equal(body.title, "Paid: Mei Ling, 1 x Cheese brownies, 2 x Choc chip cookies");
});

test("the typed invoice number finds the same invoice as the id", async () => {
  const app = await sent();
  const [row] = await app.rowsOf("Arif");
  const { body } = await app.check(row.invoiceNumber);
  assert.equal(body.invoiceId, row.invoiceId);
  assert.equal(body.buyer, "Arif");
});

test("marked paid counts as paid, and a final status needs no PayPal call", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  await app.call(`/api/invoices/${id}/payment`, "POST", { method: "CASH" });
  app.tick(CACHE_MS);
  const before = gets(app.fake);
  const { body } = await app.check(id);
  assert.equal(body.paid, true);
  assert.equal(body.status, "Paid (cash/bank)");
  assert.equal(body.title, "Paid: Lina, 3 x Classic brownies");
  assert.equal(gets(app.fake), before, "PayPal was not asked again");
});

test("part paid is not paid: no cash shortcut state, and the words say so", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.pay(id, "PARTIALLY_PAID");
  const { body } = await app.check(id);
  assert.equal(body.paid, false);
  assert.equal(body.state, "part-paid");
  assert.equal(body.title, "Part paid: RM 54.00 in total");
});

test("cancelled or refunded at PayPal is not paid, and says so", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.pay(id, "CANCELLED");
  const { body } = await app.check(id);
  assert.equal(body.paid, false);
  assert.equal(body.state, "cancelled");
  assert.equal(body.title, "Cancelled or refunded: RM 54.00");
});

test("an invoice that isn't in this table: \"Not in your orders\", no PayPal call", async () => {
  const app = await sent();
  const before = app.fake.calls.length;
  assert.deepEqual(await app.check("INV2-AAAA-BBBB-CCCC-DDDD"), { status: 200, body: { notice: NOT_IN_ORDERS, notInOrders: true } });
  assert.equal(NOT_IN_ORDERS, "Not in your orders.");
  assert.equal(app.fake.calls.length, before);
});

test("another visitor's invoice is not in my orders: the id can't open it, and it can't be collected", async () => {
  const fake = fakePayPal();
  const ana = testVisitor();
  const ben = testVisitor({ dir: ana.dir, rows: [], source: null });
  const app = await sent({ visitor: ana, fake });
  const id = await app.invoiceOf("Lina");
  fake.pay(id);
  const asBen = app.callAs(ben);
  const before = fake.calls.length;
  assert.deepEqual((await asBen("/api/pickup/check", "POST", { invoiceId: id })).body, { notice: NOT_IN_ORDERS, notInOrders: true });
  assert.deepEqual((await asBen("/api/pickup/collected", "POST", { invoiceId: id })).body, { notice: NOT_IN_ORDERS, notInOrders: true });
  assert.equal(fake.calls.length, before);
  assert.equal((await app.rowsOf("Lina"))[0].collected, undefined);
});

test("text that is no invoice at all gets the same words as a stranger's QR, no PayPal call", async () => {
  const app = await sent();
  const before = app.fake.calls.length;
  for (const text of ["hello", "", "https://example.com", "inv2-bkcu-nge3-rzg3-u35y"]) {
    assert.deepEqual(await app.check(text), { status: 200, body: { notice: NOT_OUR_QR } });
  }
  assert.equal(app.fake.calls.length, before);
});

test("a wrongly shaped request -> 400", async () => {
  const app = await sent();
  for (const body of [{}, { invoiceId: 7 }, { invoiceId: ["x"] }, null]) {
    assert.equal((await app.call("/api/pickup/check", "POST", body)).status, 400);
    assert.equal((await app.call("/api/pickup/collected", "POST", body)).status, 400);
  }
  const id = await app.invoiceOf("Lina");
  assert.equal((await app.collected(id, { undo: "yes" })).status, 400);
});

test("an invoice that was never sent can't be checked: friendly words, no PayPal call", async () => {
  const app = await start();
  app.fake.failNext("send", 500, { name: "INTERNAL_SERVER_ERROR", message: "Try later." });
  await app.call("/api/invoices", "POST", { buyer: "Lina" });
  const [row] = await app.rowsOf("Lina");
  assert.equal(row.invoiceStatus, "Draft");
  const before = app.fake.calls.length;
  assert.deepEqual((await app.check(row.invoiceId)).body, { notice: "Lina's invoice was never sent. Send it first." });
  assert.equal(app.fake.calls.length, before);
});

test("the 10-second cache is respected: a second check asks PayPal nothing; after 10 s it asks again", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  await app.check(id);
  const before = gets(app.fake);
  app.fake.pay(id);
  const cached = await app.check(id);
  assert.equal(gets(app.fake), before);
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.paid, false, "the cached answer");
  app.tick(CACHE_MS);
  const live = await app.check(id);
  assert.equal(live.body.cached, false);
  assert.equal(live.body.paid, true);
});

test("the rate limit is respected: over it the route doesn't run", async () => {
  const limits = { ...RATE_LIMITS, pickup: { limit: 1, windowMs: 600_000 } };
  const app = await sent({ limits });
  const id = await app.invoiceOf("Lina");
  assert.equal((await app.check(id)).body.buyer, "Lina");
  const before = app.fake.calls.length;
  assert.deepEqual((await app.check(id)).body, { notice: slowDown(600_000), rateLimited: true });
  assert.equal(app.fake.calls.length, before);
});

test("PayPal can't be reached: it never claims paid or unpaid, and the next check works", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.failNext("get", 500, { name: "INTERNAL_SERVER_ERROR", message: "Try later." }, ({ path }) => path.endsWith(id));
  const { status, body } = await app.check(id);
  assert.equal(status, 200);
  assert.equal(body.paid, false);
  assert.equal(body.state, "unknown");
  assert.equal(body.title, "Couldn't check with PayPal");
  assert.equal(body.detail, "Lina, 3 x Classic brownies");
  app.tick(CACHE_MS);
  assert.equal((await app.check(id)).body.state, "unpaid");
});

test("New batch or Reset while PayPal answers: the invoice is no longer in the table", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  const release = app.fake.hold("get");
  const waiting = app.fake.waiting("get");
  const checking = app.check(id);
  await waiting;
  await app.call("/api/reset", "POST", {});
  release();
  assert.deepEqual((await checking).body, { notice: NOT_IN_ORDERS, notInOrders: true });
});

test("missing PayPal keys -> the not-configured words (200), no PayPal call", async () => {
  const keyed = await sent();
  const id = await keyed.invoiceOf("Lina");
  const app = await start({ env: {}, visitor: keyed.visitor });
  assert.deepEqual((await app.check(id)).body, { notice: NOT_CONFIGURED });
  assert.equal(app.fake.calls.length, 0);
});

test("Collected: only when paid; it is our own status and never reaches PayPal", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.pay(id);
  await app.check(id);
  const before = app.fake.calls.length;
  const { status, body } = await app.collected(id);
  assert.equal(status, 200);
  assert.equal(body.collected, true);
  assert.equal(body.title, "Paid: Lina, 3 x Classic brownies");
  assert.ok(body.orders.filter((row) => row.buyer === "Lina").every((row) => row.collected === true), "the reply carries the table");
  assert.equal(app.fake.calls.length, before, "nothing was sent to PayPal");
  assert.equal(app.fake.invoices.get(id).status, "PAID");
});

test("Collected works for a cash payment too", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  await app.call(`/api/invoices/${id}/payment`, "POST", { method: "CASH" });
  assert.equal((await app.collected(id)).body.collected, true);
});

test("Collected is refused until the invoice is paid: words, not an error, and nothing is saved", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  assert.deepEqual(await app.collected(id), { status: 200, body: { notice: "Lina's invoice isn't paid yet, so it can't be marked Collected." } });
  assert.equal((await app.rowsOf("Lina"))[0].collected, undefined);
  app.fake.pay(id, "PARTIALLY_PAID");
  await app.check(id);
  assert.equal((await app.collected(id)).body.notice, "Lina's invoice isn't paid yet, so it can't be marked Collected.");
});

test("Collected marks every item of that invoice, and only that invoice", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Mei Ling");
  app.fake.pay(id);
  await app.check(id);
  await app.collected(id);
  assert.ok((await app.rowsOf("Mei Ling")).every((row) => row.collected === true));
  assert.equal((await app.rowsOf("Lina"))[0].collected, undefined);
});

test("a second scan of a collected invoice says it is already collected", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.pay(id);
  await app.check(id);
  await app.collected(id);
  assert.equal((await app.check(id)).body.collected, true);
});

test("Undo takes Collected back; PayPal is not touched and the invoice stays paid", async () => {
  const app = await sent();
  const id = await app.invoiceOf("Lina");
  app.fake.pay(id);
  await app.check(id);
  await app.collected(id);
  const before = app.fake.calls.length;
  const { status, body } = await app.collected(id, { undo: true });
  assert.equal(status, 200);
  assert.equal(body.collected, false);
  assert.equal(body.paid, true);
  assert.equal((await app.rowsOf("Lina"))[0].collected, undefined);
  assert.equal(app.fake.calls.length, before);
});

test("Collected survives a restart (the visitor's file)", async () => {
  const fake = fakePayPal();
  const app = await sent({ fake });
  const id = await app.invoiceOf("Lina");
  fake.pay(id);
  await app.check(id);
  await app.collected(id);
  const restarted = await start({ visitor: app.visitor, fake });
  assert.equal((await restarted.rowsOf("Lina"))[0].collected, true);
});
