// Tests for sending invoices ONE BUYER AT A TIME (the progress bar): the page calls POST /api/invoices
// with { buyer } for each clear buyer and moves the bar only after each real reply. These tests prove
// each reply is a real result, a failed buyer doesn't stop the others, and a double click still makes
// nothing new. The server guards are the same ones as "send all" (src/invoices.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const CLEAR_BUYERS = ["Lina", "Hafiz", "Mei Ling", "Aisyah", "Arif", "Sarah", "Kak Ros"];

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start() {
  const fake = fakePayPal();
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json");
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, storeFile, paypal }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const sendOne = async (buyer) => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ buyer }) });
    return { status: res.status, body: await res.json() };
  };
  return { fake, sendOne };
}

const invoicedBuyers = (state) => new Set(state.orders.filter((row) => row.invoiceId && row.invoiceStatus !== "Draft").map((row) => row.buyer)).size;

test("one buyer at a time: each reply is a REAL result, so the count after reply n is n invoices at PayPal", async () => {
  const app = await start();
  for (const [n, buyer] of CLEAR_BUYERS.entries()) {
    const { status, body } = await app.sendOne(buyer);
    assert.equal(status, 200);
    assert.deepEqual(body.sent.map((s) => s.buyer), [buyer]);
    assert.equal(app.fake.invoices.size, n + 1, `after ${buyer}`); // the bar may only say "n + 1 of 7" now
    assert.equal(invoicedBuyers(body), n + 1);
  }
});

test("a failed buyer doesn't stop the others: 6 of 7 sent, the failed one says why, and a retry sends it", async () => {
  const app = await start();
  const results = [];
  for (const buyer of CLEAR_BUYERS) {
    if (buyer === "Arif") app.fake.failNext("create", 500, { name: "INTERNAL_SERVER_ERROR", message: "Try again later." });
    results.push((await app.sendOne(buyer)).body);
  }
  assert.equal(results.filter((r) => r.sent.length).length, 6);
  const arif = results[CLEAR_BUYERS.indexOf("Arif")];
  assert.deepEqual(arif.sent, []);
  assert.equal(arif.failed[0].buyer, "Arif");
  assert.match(arif.failed[0].reason, /PayPal could not create the invoice \(HTTP 500, INTERNAL_SERVER_ERROR\)/);
  assert.equal(app.fake.invoices.size, 6);
  const retry = (await app.sendOne("Arif")).body;
  assert.deepEqual(retry.sent.map((s) => s.buyer), ["Arif"]);
  assert.equal(app.fake.invoices.size, 7);
});

test("a double click on the same buyer still makes ONE invoice; a buyer already sent is skipped, nothing new", async () => {
  const app = await start();
  const release = app.fake.hold();
  const held = app.fake.waiting("create");
  const first = app.sendOne("Lina");
  await held;
  const second = await app.sendOne("Lina");
  release();
  assert.deepEqual(second.body.skipped, [{ buyer: "Lina", reason: "Being invoiced right now." }]);
  assert.deepEqual((await first).body.sent.map((s) => s.buyer), ["Lina"]);
  const creates = app.fake.count("create");
  const third = (await app.sendOne("Lina")).body;
  assert.deepEqual(third.skipped, [{ buyer: "Lina", reason: "Already invoiced." }]);
  assert.equal(app.fake.count("create"), creates);
  assert.equal(app.fake.invoices.size, 1);
});
