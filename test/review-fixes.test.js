// Fix session A: the money and correctness findings from the 1 Nov review, one test group per finding.
// PayPal is the fake in scripts/fake-paypal.mjs and the AI is a fake that returns exactly the orders given, so
// a prompt-injected or broken reply can be played without a real call. Every server gets a temporary folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi } from "../src/ai.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id", PAYPAL_CLIENT_SECRET: "fake-secret", AI_MODE: "mock" };
const noUsage = { left: () => 0, take() {}, useUp() {}, totalLeft: () => 40 };
const mockAi = () => createAi({ mode: "mock", usage: noUsage, cacheDir: mkdtempSync(join(tmpdir(), "chatching-review-")) });
const fakeAi = (orders) => ({ parse: async () => ({ orders, from: "fake" }), callsLeft: () => 40 });

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ ai = mockAi(), now, limiter, wrapFetch = (f) => f } = {}) {
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: "fake-client-id", clientSecret: "fake-secret", fetch: wrapFetch(fake.fetch), now });
  const app = createApp(loadConfig(FAKE_KEYS), {
    log: () => {}, visitorsDir: mkdtempSync(join(tmpdir(), "chatching-review-")), ai, paypal, ...(now && { now }), ...(limiter && { limiter }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, fake };
}

// A browser-like client: keeps the visitor cookie.
function client(base) {
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body !== undefined && { "Content-Type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    cookie = res.headers.getSetCookie().map((c) => c.match(/chatching_visitor=[0-9a-f]{32}/)?.[0]).find(Boolean) ?? cookie;
    return { status: res.status, body: await res.json() };
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body), put: (path, body) => call("PUT", path, body), del: (path) => call("DELETE", path) };
}

const CHAT_DATE = "2026-10-28";
const paste = (lines) => lines.map((line, i) => `[28/10 ${1 + (i % 12)}:${String(i % 60).padStart(2, "0")} AM] ${line}`).join("\n");
const readPlain = async (c, lines, chatDate = CHAT_DATE) => (await c.post("/api/parse", { text: paste(lines), chatDate, withoutAi: true })).body;
const plain = (text) => text.replace(/ /g, " "); // Intl puts a no-break space after "RM"
const rowOf = (state, buyer) => state.orders.find((row) => row.buyer === buyer);
export const order = (buyer, msgs, items, extra = {}) => ({ buyer, status: "active", sourceMsgs: msgs, items, deliveryDate: null, fulfilment: null, unclear: false, reason: "", note: "", ...extra });

// ---- #1 Double billing after New batch ----

async function billedThenPastedAgain(lines = ["Lina: 2 classic brownies", "Arif: 1 cookies"], again = lines, date = CHAT_DATE) {
  const s = await start();
  const c = client(s.base);
  await readPlain(c, lines);
  await c.post("/api/invoices", {});
  await c.post("/api/new-batch", {});
  const state = await readPlain(c, again, date);
  return { s, c, state };
}

test("#1 the same buyer on the same Chat date is unclear, with the earlier invoice's amount", async () => {
  const { state } = await billedThenPastedAgain();
  assert.equal(plain(rowOf(state, "Lina").reason), "Lina already has an invoice (RM 36.00) from an earlier batch today.");
  assert.equal(rowOf(state, "Lina").unclear, true);
  assert.equal(state.summary.ready, 0);
});

test("#1 the server refuses to bill that buyer, and an afternoon paste bills only the new buyer", async () => {
  const { s, c } = await billedThenPastedAgain(["Lina: 2 classic brownies", "Arif: 1 cookies"], ["Lina: 2 classic brownies", "Arif: 1 cookies", "Mei: 1 bahulu"]);
  assert.equal((await c.post("/api/invoices", { buyer: "Lina" })).status, 400);
  const sent = (await c.post("/api/invoices", {})).body;
  assert.deepEqual(sent.sent.map((one) => one.buyer), ["Mei"]);
  assert.equal(s.fake.invoices.size, 3);
});

test("#1 names match whatever the case or spaces", async () => {
  const { state } = await billedThenPastedAgain(["Lina: 2 classic brownies"], ["LINA: 2 classic brownies"]);
  assert.equal(state.orders[0].unclear, true);
});

test("#1 another Chat date is another day's order: no check", async () => {
  const { state } = await billedThenPastedAgain(["Lina: 2 classic brownies"], ["Lina: 2 classic brownies"], "2026-10-29");
  assert.equal(state.orders[0].unclear, false);
});

test("#1 an earlier invoice cancelled at PayPal doesn't count", async () => {
  let t = 1_000_000;
  const s = await start({ now: () => t });
  const c = client(s.base);
  await readPlain(c, ["Lina: 2 classic brownies"]);
  await c.post("/api/invoices", {});
  const { invoiceId } = (await c.get("/api/state")).body.orders[0];
  s.fake.pay(invoiceId, "CANCELLED");
  t += 11_000;
  await c.post("/api/invoices/refresh", {});
  await c.post("/api/new-batch", {});
  assert.equal((await readPlain(c, ["Lina: 2 classic brownies"])).orders[0].unclear, false);
});

test("#1 an edit doesn't clear the check, and Add item keeps it on the new row", async () => {
  const { c, state } = await billedThenPastedAgain(["Lina: 2 classic brownies"]);
  const { id } = state.orders[0];
  assert.equal((await c.put(`/api/orders/${id}`, { qty: 3 })).body.row.unclear, true);
  const added = (await c.post(`/api/buyers/${id}/items`, { itemId: "cookies", qty: 1 })).body;
  assert.equal(added.orders.length, 2);
  assert.ok(added.orders.every((row) => row.unclear));
});

test("#1 Send anyway clears it for every row of that buyer, then a genuine second order can be billed", async () => {
  const { s, c, state } = await billedThenPastedAgain(["Lina: 2 classic brownies, 1 cookies"]);
  const reply = await c.post(`/api/buyers/${state.orders[0].id}/send-anyway`);
  assert.equal(reply.status, 200);
  assert.ok(reply.body.orders.every((row) => !row.unclear));
  assert.equal((await c.post("/api/invoices", {})).body.sent.length, 1);
  assert.equal(s.fake.invoices.size, 2);
});

test("#1 Send anyway clears only this check, never another problem", async () => {
  const { c, state } = await billedThenPastedAgain(["Lina: 2 classic brownies"], ["Lina: 2 classic brownies, is it RM15?"]);
  const after2 = (await c.post(`/api/buyers/${state.orders[0].id}/send-anyway`)).body;
  assert.equal(after2.orders[0].unclear, true);
  assert.match(plain(after2.orders[0].reason), /buyer mentioned RM 15\.00/);
  assert.doesNotMatch(after2.orders[0].reason, /earlier batch/);
});

test("#1 Reset demo still starts the demo over: its saved batch keeps the links but raises no check", async () => {
  const s = await start();
  const c = client(s.base);
  await readPlain(c, ["Lina: 2 classic brownies"]);
  await c.post("/api/invoices", {});
  await c.post("/api/reset", {});
  assert.equal((await readPlain(c, ["Lina: 2 classic brownies"])).orders[0].unclear, false);
});

test("#1 Send anyway with nothing to clear is refused", async () => {
  const s = await start();
  const c = client(s.base);
  const state = await readPlain(c, ["Lina: 2 classic brownies"]);
  assert.equal((await c.post(`/api/buyers/${state.orders[0].id}/send-anyway`)).status, 400);
});
