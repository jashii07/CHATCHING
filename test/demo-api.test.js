// Tests for GET /api/demo ("Load demo", stretch #2): the demo chats + their Chat date, to fill the chat
// box. It never reads them (the judge clicks Read orders to see that step), so it costs no AI call, and
// it follows the batch rule: once invoices are sent, no new reading until New batch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start() {
  const fake = fakePayPal();
  let aiCalls = 0;
  const ai = { async parse() { aiCalls++; return { notice: "not used" }; } };
  const storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json");
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, storeFile, paypal, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { fake, call, aiCalls: () => aiCalls };
}

test("Load demo -> the demo chats and their Chat date (2026-10-28), unchanged; nothing is read or changed", async () => {
  const app = await start();
  await app.call("/api/reset", "POST", {});
  const before = (await app.call("/api/state")).body;
  const { status, body } = await app.call("/api/demo");
  assert.equal(status, 200);
  assert.deepEqual(body, { text: DEMO, chatDate: "2026-10-28", messages: 15 });
  assert.equal(app.aiCalls(), 0);
  assert.equal(app.fake.calls.length, 0);
  assert.deepEqual((await app.call("/api/state")).body, before); // the table stays empty until Read orders
});

test("the loaded demo, read as-is, is the saved Gemini reply: 9 buyers, RM 387.00 (0 real AI calls)", async () => {
  const server = createApp(loadConfig({}), { log: () => {}, storeFile: join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json") }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const demo = await (await fetch(`${base}/api/demo`)).json();
  const res = await fetch(`${base}/api/parse`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: demo.text, chatDate: demo.chatDate }) });
  const read = await res.json();
  assert.equal(read.groups.length, 9);
  assert.deepEqual(read.totals, { orders: 7, total: "387.00" });
});

test("invoices already sent -> Load demo follows the batch rule (the notice, no chats); after New batch it works again", async () => {
  const app = await start();
  await app.call("/api/invoices", "POST", {});
  assert.deepEqual(await app.call("/api/demo"), { status: 200, body: { notice: INVOICED } });
  await app.call("/api/new-batch", "POST", {});
  assert.equal((await app.call("/api/demo")).body.text, DEMO);
});
