// Tests for GET /api/buyers/:id/panel and GET /api/invoices/:id/qr (Step 7). PayPal is the FAKE in
// scripts/fake-paypal.mjs; each server has its own temporary store file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal, NOT_CONFIGURED } from "../src/paypal.js";
import { fakePayPal, QR_PNG } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS, storeFile = join(mkdtempSync(join(tmpdir(), "chatching-")), "orders.json") } = {}) {
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, storeFile, paypal }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const state = async () => (await call("/api/state")).body;
  const firstRow = async (buyer) => (await state()).orders.find((row) => row.buyer === buyer);
  return { fake, call, state, firstRow, storeFile };
}

test("panel: Arif's note and his messages, with marks; no QR before the invoice is sent", async () => {
  const app = await start();
  const arif = await app.firstRow("Arif");
  const { status, body } = await app.call(`/api/buyers/${arif.id}/panel`);
  assert.equal(status, 200);
  assert.equal(body.buyer, "Arif");
  assert.equal(body.note, arif.note);
  assert.deepEqual(body.messages.map((m) => m.n), [6, 7]);
  assert.ok(body.messages[1].parts.some((p) => p.mark === "fulfilment" && p.text === "pick up"));
  assert.equal(body.qrInvoiceId, null);
  assert.equal(app.fake.calls.length, 0); // the panel never calls PayPal
});

test("panel for any of a buyer's rows covers the whole buyer; unknown row -> 404", async () => {
  const app = await start();
  const rows = (await app.state()).orders.filter((row) => row.buyer === "Jun Wei");
  const panels = await Promise.all(rows.map((row) => app.call(`/api/buyers/${row.id}/panel`)));
  assert.deepEqual(panels[0].body, panels[1].body);
  assert.ok(panels[0].body.messages[0].parts.some((p) => p.mark === "price-check" && p.text === "RM15"));
  assert.equal((await app.call("/api/buyers/r999/panel")).status, 404);
});

test("QR: after sending, the panel names the invoice and the QR comes from PayPal once, then from memory", async () => {
  const app = await start();
  await app.call("/api/invoices", "POST", {});
  const arif = await app.firstRow("Arif");
  const panel = (await app.call(`/api/buyers/${arif.id}/panel`)).body;
  assert.equal(panel.qrInvoiceId, arif.invoiceId);
  const first = await app.call(`/api/invoices/${arif.invoiceId}/qr`);
  assert.deepEqual(first, { status: 200, body: { invoiceId: arif.invoiceId, png: QR_PNG } });
  const qrCall = app.fake.calls.find((c) => c.kind === "qr");
  assert.deepEqual(qrCall.body, { width: 300, height: 300, action: "pay" });
  await app.call(`/api/invoices/${arif.invoiceId}/qr`);
  assert.equal(app.fake.count("qr"), 1);
});

test("QR: only for sent invoices in this table (unknown id -> 404, no PayPal call)", async () => {
  const app = await start();
  assert.equal((await app.call("/api/invoices/INV2-NOPE-NOPE-NOPE-NOPE/qr")).status, 404);
  assert.equal(app.fake.count("qr"), 0);
});

test("QR: a PayPal problem is friendly words (200 { notice }), not an error; the next try asks again", async () => {
  const app = await start();
  await app.call("/api/invoices", "POST", {});
  const { invoiceId } = await app.firstRow("Lina");
  app.fake.failNext("qr", 500, { name: "INTERNAL_SERVER_ERROR", message: "Try later." });
  const failed = await app.call(`/api/invoices/${invoiceId}/qr`);
  assert.equal(failed.status, 200);
  assert.match(failed.body.notice, /^The QR code could not be loaded \(PayPal could not make the QR code .*HTTP 500/);
  assert.equal((await app.call(`/api/invoices/${invoiceId}/qr`)).body.png, QR_PNG);
});

test("QR without PayPal keys -> the not-configured notice (200), no PayPal call", async () => {
  const keyed = await start();
  await keyed.call("/api/invoices", "POST", {});
  const app = await start({ env: {}, storeFile: keyed.storeFile }); // same saved invoices, keys gone
  const { invoiceId } = await app.firstRow("Lina");
  assert.deepEqual(await app.call(`/api/invoices/${invoiceId}/qr`), { status: 200, body: { notice: NOT_CONFIGURED } });
  assert.equal(app.fake.calls.length, 0);
});
