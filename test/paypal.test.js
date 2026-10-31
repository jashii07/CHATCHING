// Tests for src/paypal.js (Step 5, Part 1): token cache, the invoice body (prices from the menu only),
// create + send without emailing anyone, the duplicate-number lookup, and safe error messages.
// Every call goes to the FAKE PayPal in scripts/fake-paypal.mjs: no network, no real keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPayPal, invoiceDraft, invoiceNumber, SANDBOX_BASE, NOT_CONFIGURED } from "../src/paypal.js";
import { toRows } from "../src/orders.js";
import { mockParse } from "../src/ai.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const KEYS = { clientId: "fake-client-id-123", clientSecret: "fake-secret-456" };
const demo = toRows(mockParse(), menu);
const rowsOf = (buyer) => demo.filter((row) => row.buyer === buyer);
const NUMBER = "CHATCHING-K3F9Q2ZA7L1X-02";

function setup(options = {}) {
  const fake = fakePayPal(options.fake);
  let clock = 1_000_000;
  const paypal = createPayPal({ ...KEYS, fetch: fake.fetch, now: () => clock, ...options.paypal });
  return { fake, paypal, tick: (ms) => (clock += ms) };
}

test("invoiceNumber: CHATCHING-{batch}-{nn}, at most PayPal's 25 characters", () => {
  assert.equal(invoiceNumber("K3F9Q2ZA7L1X", 7), "CHATCHING-K3F9Q2ZA7L1X-07");
  assert.equal(invoiceNumber("K3F9Q2ZA7L1X", 50).length, 25);
  for (const [batch, n] of [["short", 1], ["K3F9Q2ZA", 1], ["K3F9Q2Za7L1X", 1], ["K3F9Q2ZA7L1X", 0], ["K3F9Q2ZA7L1X", 100], ["K3F9Q2ZA7L1X", 1.5]]) {
    assert.throws(() => invoiceNumber(batch, n), /batch|number/, `${batch} ${n}`);
  }
});

test("invoiceDraft: Mei Ling's 2 rows -> 2 items, names + prices from menu.json, currency from the menu, total in sen", () => {
  const { body, total } = invoiceDraft({ buyer: "Mei Ling", rows: rowsOf("Mei Ling"), menu, number: NUMBER });
  assert.equal(total, "72.00");
  assert.deepEqual(body.items, [
    { name: "Cheese brownies (box of 6)", quantity: "1", unit_amount: { currency_code: "MYR", value: "22.00" }, unit_of_measure: "QUANTITY" },
    { name: "Choc chip cookies (jar)", quantity: "2", unit_amount: { currency_code: "MYR", value: "25.00" }, unit_of_measure: "QUANTITY" },
  ]);
  assert.equal(body.detail.currency_code, "MYR");
  assert.equal(body.detail.invoice_number, NUMBER);
  assert.match(body.detail.note, /Mei Ling/);
  assert.equal(body.primary_recipients, undefined); // no buyer email: nobody is emailed
});

test("invoiceDraft: the price ALWAYS comes from the menu, never from the row (the golden rule)", () => {
  const tampered = rowsOf("Lina").map((row) => ({ ...row, unitPrice: "0.01", lineTotal: "0.03" }));
  const { body, total } = invoiceDraft({ buyer: "Lina", rows: tampered, menu, number: NUMBER });
  assert.equal(body.items[0].unit_amount.value, "18.00");
  assert.equal(total, "54.00");
});

test("invoiceDraft: the currency follows the menu setting (USD -> USD)", () => {
  const usd = { ...menu, currency: "USD" };
  const { body } = invoiceDraft({ buyer: "Lina", rows: rowsOf("Lina"), menu: usd, number: NUMBER });
  assert.equal(body.detail.currency_code, "USD");
  assert.equal(body.items[0].unit_amount.currency_code, "USD");
});

test("invoiceDraft refuses unclear rows, cancelled rows, unknown items and an empty list", () => {
  assert.throws(() => invoiceDraft({ buyer: "Priya", rows: rowsOf("Priya"), menu, number: NUMBER }), /needs a check/);
  assert.throws(() => invoiceDraft({ buyer: "Danish", rows: rowsOf("Danish"), menu, number: NUMBER }), /cancelled/);
  const ghost = rowsOf("Lina").map((row) => ({ ...row, itemId: "pizza" }));
  assert.throws(() => invoiceDraft({ buyer: "Lina", rows: ghost, menu, number: NUMBER }), /not on the menu/);
  assert.throws(() => invoiceDraft({ buyer: "Lina", rows: [], menu, number: NUMBER }), /no items/);
});

test("sandbox only: any other base URL is refused before a single call", () => {
  assert.equal(SANDBOX_BASE, "https://api-m.sandbox.paypal.com");
  for (const baseUrl of ["https://api-m.paypal.com", "https://api.paypal.com", "http://api-m.sandbox.paypal.com", "https://evil.example"]) {
    assert.throws(() => createPayPal({ ...KEYS, baseUrl, fetch: () => assert.fail("no call") }), /sandbox/, baseUrl);
  }
});

test("missing keys -> \"PayPal is not configured\", and no call is made", async () => {
  const paypal = createPayPal({ clientId: "", clientSecret: "", fetch: () => assert.fail("no call") });
  await assert.rejects(paypal.token(), (err) => err.message === NOT_CONFIGURED && err.status === 503);
  assert.match(NOT_CONFIGURED, /^PayPal is not configured/);
});

test("the token is cached until 5 minutes before it expires, then fetched again", async () => {
  const { fake, paypal, tick } = setup({ fake: { expiresIn: 3600 } });
  const first = await paypal.token();
  assert.equal(await paypal.token(), first);
  tick((3600 - 301) * 1000);
  assert.equal(await paypal.token(), first);
  tick(2000); // now inside the last 5 minutes
  assert.notEqual(await paypal.token(), first);
  assert.equal(fake.count("token"), 2);
});

test("two calls at the same moment share ONE token request", async () => {
  const { fake, paypal } = setup();
  await Promise.all([paypal.token(), paypal.token(), paypal.token()]);
  assert.equal(fake.count("token"), 1);
});

test("invoiceBuyer: creates the draft, sends it WITHOUT emailing anyone, and returns the id + payer link", async () => {
  const { fake, paypal } = setup();
  const result = await paypal.invoiceBuyer({ buyer: "Mei Ling", rows: rowsOf("Mei Ling"), menu, number: NUMBER });
  assert.deepEqual(result, {
    invoiceId: "INV2-FAKE-0001", invoiceNumber: NUMBER, status: "UNPAID",
    payerLink: "https://www.sandbox.paypal.com/invoice/p/#INV2-FAKE-0001", reused: false,
  });
  const send = fake.calls.find((c) => c.kind === "send");
  assert.deepEqual(send.body, { send_to_recipient: false, send_to_invoicer: false });
  assert.equal(fake.invoices.get("INV2-FAKE-0001").amount.value, "72.00");
});

test("duplicate number: PayPal refuses it, so the EXISTING invoice is looked up; nothing new is made or re-sent", async () => {
  const { fake, paypal } = setup();
  const id = fake.add({ status: "UNPAID", detail: { invoice_number: NUMBER, currency_code: "MYR" }, amount: { currency_code: "MYR", value: "72.00" } });
  const result = await paypal.invoiceBuyer({ buyer: "Mei Ling", rows: rowsOf("Mei Ling"), menu, number: NUMBER });
  assert.equal(result.invoiceId, id);
  assert.equal(result.reused, true);
  assert.equal(result.status, "UNPAID");
  assert.match(result.payerLink, new RegExp(id));
  assert.equal(fake.invoices.size, 1);
  assert.equal(fake.count("send"), 0);
});

test("duplicate number whose invoice is still a DRAFT (send failed last time) -> it is sent now", async () => {
  const { fake, paypal } = setup();
  const id = fake.add({ detail: { invoice_number: NUMBER, currency_code: "MYR" }, amount: { currency_code: "MYR", value: "72.00" } });
  const result = await paypal.invoiceBuyer({ buyer: "Mei Ling", rows: rowsOf("Mei Ling"), menu, number: NUMBER });
  assert.equal(result.invoiceId, id);
  assert.equal(result.status, "UNPAID");
  assert.equal(fake.count("send"), 1);
});

test("a saved invoice id (draft from a failed send) -> no new invoice, just send it", async () => {
  const { fake, paypal } = setup();
  const id = fake.add({ detail: { invoice_number: NUMBER, currency_code: "MYR" }, amount: { currency_code: "MYR", value: "72.00" } });
  const result = await paypal.invoiceBuyer({ buyer: "Mei Ling", rows: rowsOf("Mei Ling"), menu, number: NUMBER, invoiceId: id });
  assert.equal(result.invoiceId, id);
  assert.equal(fake.count("create"), 0);
  assert.equal(fake.count("send"), 1);
});

test("PayPal's total differs from the menu's -> NOT sent, with a clear reason (check first, charge second)", async () => {
  const { fake, paypal } = setup();
  fake.setWrongTotal(true);
  await assert.rejects(paypal.invoiceBuyer({ buyer: "Lina", rows: rowsOf("Lina"), menu, number: NUMBER }),
    (err) => /PayPal's total \(54\.01 MYR\) is not the menu's \(54\.00 MYR\)/.test(err.message) && err.invoiceId === "INV2-FAKE-0001");
  assert.equal(fake.count("send"), 0);
});

test("an expired token (401) is replaced once and the call retried", async () => {
  const { fake, paypal } = setup();
  await paypal.token();
  fake.expireTokens();
  const result = await paypal.invoiceBuyer({ buyer: "Lina", rows: rowsOf("Lina"), menu, number: NUMBER });
  assert.equal(result.status, "UNPAID");
  assert.equal(fake.count("token"), 2);
});

test("wrong keys -> a clear message that never contains a key or token", async () => {
  const { fake, paypal } = setup();
  fake.failNext("token", 401, { error: "invalid_client", error_description: "Client Authentication failed" });
  await assert.rejects(paypal.token(), (err) => {
    assert.match(err.message, /PayPal refused the keys/);
    for (const secret of [KEYS.clientId, KEYS.clientSecret, "fake-token"]) assert.ok(!err.message.includes(secret));
    return true;
  });
});

test("PayPal errors name PayPal's issue but never the token; network errors and timeouts are clear", async () => {
  const { fake, paypal } = setup();
  fake.failNext("create", 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CURRENCY_NOT_SUPPORTED", description: "Currency is not supported." }] });
  await assert.rejects(paypal.invoiceBuyer({ buyer: "Lina", rows: rowsOf("Lina"), menu, number: NUMBER }), (err) => {
    assert.match(err.message, /CURRENCY_NOT_SUPPORTED/);
    assert.ok(!err.message.includes("fake-token"));
    return true;
  });
  fake.throwNext("create", Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
  await assert.rejects(paypal.invoiceBuyer({ buyer: "Lina", rows: rowsOf("Lina"), menu, number: NUMBER }), /Can't reach PayPal \(ENOTFOUND\)/);

  const slow = createPayPal({ ...KEYS, timeoutMs: 30, fetch: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }) });
  await assert.rejects(slow.token(), /PayPal took too long/);
});
