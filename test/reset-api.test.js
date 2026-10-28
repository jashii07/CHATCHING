// Tests for POST /api/reset (Step 6, Part 3): "Reset demo" clears the saved orders so the demo can start
// over. It never deletes or cancels anything in PayPal; invoices already sent are saved to batches/ first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };
const EMPTY_SUMMARY = { orders: 0, ready: 0, expected: "0.00", paidOrders: 0, paid: "0.00", needsCheck: 0 };

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS } = {}) {
  const fake = fakePayPal();
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json");
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, storeFile, paypal }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { fake, call, storeFile, reset: () => call("/api/reset", "POST", {}) };
}

test("Reset demo empties the table and the saved orders file, with a new batch id", async () => {
  const app = await start();
  const before = (await app.call("/api/state")).body;
  const { status, body } = await app.reset();
  assert.equal(status, 200);
  assert.deepEqual([body.orders, body.groups, body.source, body.summary], [[], [], null, EMPTY_SUMMARY]);
  assert.notEqual(body.batch, before.batch);
  const saved = JSON.parse(readFileSync(app.storeFile, "utf8"));
  assert.deepEqual([saved.rows, saved.source], [[], null]);
  assert.deepEqual((await app.call("/api/state")).body.orders, []);
});

test("without invoices nothing is archived; it works without PayPal keys too (PayPal isn't involved)", async () => {
  const app = await start({ env: {} });
  assert.equal((await app.reset()).status, 200);
  assert.ok(!existsSync(join(dirname(app.storeFile), "batches")));
  assert.equal(app.fake.calls.length, 0);
});

test("Reset never deletes or cancels anything in PayPal; sent invoices are kept in batches/ with their links", async () => {
  const app = await start();
  const sent = (await app.call("/api/invoices", "POST", {})).body;
  const callsBefore = app.fake.calls.length;
  const statuses = [...app.fake.invoices.values()].map((inv) => inv.status);
  await app.reset();
  assert.equal(app.fake.calls.length, callsBefore); // not a single PayPal call
  assert.deepEqual([...app.fake.invoices.values()].map((inv) => inv.status), statuses);
  assert.equal(app.fake.invoices.size, 7);
  const dir = join(dirname(app.storeFile), "batches");
  assert.deepEqual(readdirSync(dir), [`${sent.batch}.json`]);
  const archived = JSON.parse(readFileSync(join(dir, `${sent.batch}.json`), "utf8"));
  assert.equal(archived.rows.filter((row) => row.payerLink).length, 10);
});

test("after Reset the demo starts over: Read orders works again (even after invoices were sent)", async () => {
  const app = await start();
  await app.call("/api/invoices", "POST", {});
  await app.reset();
  const read = (await app.call("/api/parse", "POST", { text: DEMO, chatDate: "2026-10-28" })).body;
  assert.equal(read.groups.length, 9);
  assert.deepEqual(read.totals, { orders: 7, total: "387.00" });
});

test("Reset waits while invoices are being sent", async () => {
  const app = await start();
  const release = app.fake.hold();
  const sending = app.call("/api/invoices", "POST", {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual((await app.reset()).body, { notice: "Invoices are being sent right now. Please wait for that to finish." });
  release();
  await sending;
});
