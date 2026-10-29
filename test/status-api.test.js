// Tests for POST /api/invoices/refresh (Step 6, Part 1): ask PayPal for each open invoice's status and
// save it. A 10-second cache (and one shared round at a time) means many tabs polling can't flood PayPal.
// PayPal is the FAKE in scripts/fake-paypal.mjs; the clock is ours, so no test waits 10 real seconds,
// and no test sleeps: "wait for PayPal" tests wait for the fake to say a call is held (fake.waiting).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal, NOT_CONFIGURED } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS } = {}) {
  const fake = fakePayPal();
  let clock = 1_000_000;
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json");
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, storeFile, paypal, now: () => clock }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return {
    fake, call,
    tick: (ms) => (clock += ms),
    state: async () => (await call("/api/state")).body,
    send: () => call("/api/invoices", "POST", {}),
    refresh: () => call("/api/invoices/refresh", "POST", {}),
  };
}

const rowsOf = (state, buyer) => state.orders.filter((row) => row.buyer === buyer);
const invoiceOf = (state, buyer) => rowsOf(state, buyer)[0].invoiceId;
const getsOf = (fake) => fake.calls.filter((c) => c.kind === "get" && c.method === "GET").length;

test("missing PayPal keys -> 503 \"PayPal is not configured\", nothing called", async () => {
  const app = await start({ env: {} });
  assert.deepEqual(await app.refresh(), { status: 503, body: { error: NOT_CONFIGURED } });
  assert.equal(app.fake.calls.length, 0);
});

test("nothing invoiced yet -> no PayPal call at all", async () => {
  const app = await start();
  const { status, body } = await app.refresh();
  assert.equal(status, 200);
  assert.deepEqual([body.changed, body.failed, body.checked], [[], [], 0]);
  assert.equal(app.fake.calls.length, 0);
});

test("a buyer pays in the sandbox -> Refresh saves Paid, the Paid card counts it, the others stay Sent", async () => {
  const app = await start();
  const sent = (await app.send()).body;
  app.fake.pay(invoiceOf(sent, "Lina"));
  app.tick(11_000);
  const gets = getsOf(app.fake);
  const { body } = await app.refresh();
  assert.deepEqual(body.changed, [{ buyer: "Lina", from: "Sent", to: "Paid" }]);
  assert.equal(body.checked, 7);
  assert.equal(getsOf(app.fake) - gets, 7); // one GET per open invoice
  assert.ok(rowsOf(body, "Lina").every((row) => row.invoiceStatus === "Paid"));
  assert.ok(rowsOf(body, "Hafiz").every((row) => row.invoiceStatus === "Sent"));
  assert.deepEqual([body.summary.paidOrders, body.summary.paid], [1, "54.00"]);
  assert.deepEqual((await app.state()).orders, body.orders); // saved
});

test("a paid invoice is not asked again; part paid and cancelled map to the app's words", async () => {
  const app = await start();
  const sent = (await app.send()).body;
  app.fake.pay(invoiceOf(sent, "Lina"));
  app.fake.pay(invoiceOf(sent, "Hafiz"), "PARTIALLY_PAID");
  app.fake.pay(invoiceOf(sent, "Arif"), "CANCELLED");
  app.tick(11_000);
  const first = (await app.refresh()).body;
  assert.deepEqual(first.changed.map((c) => `${c.buyer}: ${c.to}`), ["Lina: Paid", "Hafiz: Part paid", "Arif: Cancelled/Refunded"]);
  app.tick(11_000);
  const gets = getsOf(app.fake);
  const second = (await app.refresh()).body;
  assert.equal(second.checked, 5); // Lina (paid) and Arif (cancelled) are final; Hafiz (part paid) is still open
  assert.equal(getsOf(app.fake) - gets, 5);
});

test("within 10 seconds a second Refresh is answered from the cache: no PayPal call", async () => {
  const app = await start();
  await app.send();
  app.tick(11_000);
  await app.refresh();
  const gets = getsOf(app.fake);
  app.tick(9_000);
  const cached = (await app.refresh()).body;
  assert.equal(cached.cached, true);
  assert.equal(getsOf(app.fake), gets);
  app.tick(2_000); // 11 s after the last real check
  const fresh = (await app.refresh()).body;
  assert.equal(fresh.cached, false);
  assert.equal(getsOf(app.fake) - gets, 7);
});

test("sending invoices counts as a fresh check: a Refresh right after it waits for the cache", async () => {
  const app = await start();
  await app.send();
  const gets = getsOf(app.fake);
  assert.equal((await app.refresh()).body.cached, true);
  assert.equal(getsOf(app.fake), gets);
});

test("many tabs at the same moment share ONE round of PayPal calls", async () => {
  const app = await start();
  await app.send();
  app.tick(11_000);
  const gets = getsOf(app.fake);
  const release = app.fake.hold("get");
  const held = app.fake.waiting("get");
  const tabs = [app.refresh(), app.refresh(), app.refresh()];
  await held; // the round is really waiting for PayPal
  release();
  const replies = await Promise.all(tabs);
  assert.ok(replies.every((r) => r.status === 200));
  assert.equal(getsOf(app.fake) - gets, 7);
});

test("PayPal fails for one invoice -> that buyer is listed in failed, keeps its status; the rest update", async () => {
  const app = await start();
  const sent = (await app.send()).body;
  app.fake.pay(invoiceOf(sent, "Hafiz"));
  app.fake.failNext("get", 503, { name: "SERVICE_UNAVAILABLE", message: "Service unavailable." });
  app.tick(11_000);
  const { status, body } = await app.refresh();
  assert.equal(status, 200);
  assert.equal(body.failed.length, 1);
  assert.equal(body.failed[0].buyer, "Lina"); // the first invoice asked
  assert.match(body.failed[0].reason, /HTTP 503, SERVICE_UNAVAILABLE/);
  assert.ok(rowsOf(body, "Lina").every((row) => row.invoiceStatus === "Sent"));
  assert.deepEqual(body.changed.map((c) => c.buyer), ["Hafiz"]);
});

test("a New batch while a check is waiting for PayPal: the old statuses never land in the new table", async () => {
  const app = await start();
  const sent = (await app.send()).body;
  app.fake.pay(invoiceOf(sent, "Lina"));
  app.tick(11_000);
  const release = app.fake.hold("get");
  const held = app.fake.waiting("get");
  const checking = app.refresh();
  await held; // the check is really waiting for PayPal
  assert.equal((await app.call("/api/new-batch", "POST", {})).status, 200);
  await app.call("/api/parse", "POST", { text: DEMO, chatDate: "2026-10-28" }); // new rows r1.. with the same ids
  release();
  await checking;
  const state = await app.state();
  assert.ok(state.orders.every((row) => row.invoiceId === null && row.invoiceStatus === "Draft"));
});
