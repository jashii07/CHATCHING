// Smoke test: PayPal SANDBOX invoices, without emailing anyone.
// Run:         node --env-file-if-exists=.env scripts/smoke-invoice.mjs
//              Makes ONE real sandbox invoice for the demo buyer Lina with the app's own code
//              (src/paypal.js: prices from menu.json), sends it, and prints only its id, status and payer link.
// Duplicate:   node --env-file-if-exists=.env scripts/smoke-invoice.mjs --dup-test INVOICE_ID
//              Tries that invoice's number again: PayPal must refuse it, and the lookup must find the same
//              invoice. Creates nothing (a draft PayPal unexpectedly accepts is deleted at once).
// Check:       node --env-file=.env scripts/smoke-invoice.mjs --check INVOICE_ID
// QR code:     node --env-file=.env scripts/smoke-invoice.mjs --qr INVOICE_ID           (saves tmp/qr-INVOICE_ID.png)
// Record cash: node --env-file=.env scripts/smoke-invoice.mjs --record-cash INVOICE_ID
// Idempotency: node --env-file=.env scripts/smoke-invoice.mjs --idem-test               (creates + deletes 1-2 drafts)
// Never prints the token, client ID or secret.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPayPal, invoiceDraft, invoiceNumber } from "../src/paypal.js";
import { demoRows, newBatchId } from "../src/store.js";

const BASE = "https://api-m.sandbox.paypal.com";
const CURRENCIES = ["MYR", "USD"]; // try MYR first, fall back to USD
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const HINTS = {
  400: "PayPal did not accept the request body. Read the issue details above.",
  401: "PayPal rejected the keys. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are from the same Sandbox app.",
  403: "The app or account is not allowed to do this. Invoicing may not be enabled for this sandbox app/business account.",
  404: "Invoice not found. Check the invoice ID, and that it was created with these same sandbox keys.",
  422: "PayPal understood the request but refused it for a business reason (for example an unsupported currency). Read the issue details above.",
  500: "PayPal's sandbox had an internal problem. Wait a minute and try again.",
  503: "PayPal's sandbox is temporarily unavailable. Wait a minute and try again.",
};

// Errors that mean "Invoicing is switched off", so trying another currency won't help.
const NOT_ENABLED = ["NOT_AUTHORIZED", "PERMISSION_DENIED", "USER_NOT_AUTHORIZED"];

function printError(step, status, body) {
  console.log(`FAILED at: ${step}`);
  console.log(`HTTP status: ${status}`);
  const name = body?.error ?? body?.name;
  const message = body?.error_description ?? body?.message;
  if (name) console.log(`PayPal error: ${name}`);
  if (message) console.log(`PayPal message: ${message}`);
  for (const d of body?.details ?? []) {
    console.log(`  issue: ${d.issue}${d.field ? ` (field ${d.field})` : ""} - ${d.description ?? ""}`);
  }
  if (body?.debug_id) console.log(`debug_id: ${body.debug_id}`);
  console.log(`Likely cause: ${HINTS[status] ?? "Unexpected error. Check the PayPal message above."}`);
}

function isNotEnabled(status, body) {
  return status === 403 || NOT_ENABLED.includes(body?.name) || NOT_ENABLED.includes(body?.details?.[0]?.issue);
}

async function call(method, path, token, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, body: json };
}

async function getToken() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) {
    console.log("token OK: no");
    console.log("Likely cause: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is empty, or --env-file=.env was not used.");
    return null;
  }
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || !body?.access_token) {
    console.log("token OK: no");
    printError("get access token", res.status, body);
    return null;
  }
  console.log("token OK: yes");
  return body.access_token;
}

function draftBody(currency, buyerEmail) {
  const money = (value) => ({ currency_code: currency, value });
  const invoice = {
    detail: { currency_code: currency, note: "Smoke test invoice from ChatChing." },
    items: [
      { name: "Brownies (box of 6)", quantity: "2", unit_amount: money("15.00") },
      { name: "Kek batik (1 slab)", quantity: "1", unit_amount: money("25.00") },
    ],
  };
  if (buyerEmail) invoice.primary_recipients = [{ billing_info: { email_address: buyerEmail } }];
  return invoice;
}

// With "Prefer: return=representation" PayPal returns the invoice; otherwise only a link to it.
const invoiceIdFrom = (r) => r.body?.id ?? r.body?.href?.split("/").pop();

async function showStatus(token, id, label) {
  const r = await call("GET", `/v2/invoicing/invoices/${id}`, token);
  if (!r.ok) {
    printError(`get invoice (${label})`, r.status, r.body);
    return null;
  }
  const amount = r.body.amount ? `${r.body.amount.value} ${r.body.amount.currency_code}` : "(none)";
  console.log(`[${label}] invoice ID: ${r.body.id}  status: ${r.body.status}  total: ${amount}`);
  return r.body;
}

function printPayments(inv) {
  for (const p of inv.payments?.transactions ?? []) {
    console.log(`payment: ${p.amount?.value} ${p.amount?.currency_code}  method: ${p.method}  date: ${p.payment_date}`);
  }
}

async function check(token, id) {
  const inv = await showStatus(token, id, "check");
  if (!inv) return 1;
  console.log(`recipient_view_url: ${inv.detail?.metadata?.recipient_view_url ?? "(not present)"}`);
  printPayments(inv);
  return 0;
}

async function qr(token, id) {
  const res = await fetch(`${BASE}/v2/invoicing/invoices/${id}/generate-qr-code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ width: 300, height: 300, action: "pay" }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {}
    printError("generate QR code", res.status, body);
    return 1;
  }
  console.log(`QR response: HTTP ${res.status}  content-type: ${res.headers.get("content-type") ?? "(none)"}  size: ${raw.length} bytes`);

  // Docs say "a PNG image in Base64-encoded format" but not how it is wrapped. Sandbox sends
  // multipart/form-data with the Base64 text in a part named "image". Every Base64 PNG starts
  // with "iVBORw0KGgo" (the encoded PNG signature), so read the Base64 from there.
  let png = raw.subarray(0, 8).equals(PNG_MAGIC) ? raw : null;
  if (!png) {
    const text = raw.toString("utf8");
    const start = text.indexOf("iVBORw0KGgo");
    const b64 = start >= 0 ? text.slice(start).match(/^[A-Za-z0-9+/=\r\n]+/)[0] : null;
    const decoded = b64 ? Buffer.from(b64.replace(/\s/g, ""), "base64") : null;
    if (decoded?.subarray(0, 8).equals(PNG_MAGIC)) png = decoded;
    else console.log(`first 120 chars of body: ${JSON.stringify(text.slice(0, 120))}`);
  }
  if (!png) {
    console.log("PNG found: no");
    return 1;
  }
  mkdirSync("tmp", { recursive: true });
  const file = `tmp/qr-${id}.png`;
  writeFileSync(file, png);
  console.log(`PNG found: yes (${png.length} bytes)  saved: ${file}`);
  return 0;
}

async function recordCash(token, id) {
  const inv = await showStatus(token, id, "before record-cash");
  if (!inv) return 1;
  const due = inv.due_amount ?? inv.amount;
  const r = await call("POST", `/v2/invoicing/invoices/${id}/payments`, token, {
    method: "CASH",
    payment_date: new Date().toISOString().slice(0, 10), // UTC date, so it is never in the future for PayPal
    amount: { currency_code: due.currency_code, value: due.value },
    note: "Cash recorded by smoke test.",
  });
  if (!r.ok) {
    printError("record payment", r.status, r.body);
    return 1;
  }
  console.log(`record payment: HTTP ${r.status}  payment_id: ${r.body?.payment_id ?? "-"}`);
  const after = await showStatus(token, id, "after record-cash");
  if (!after) return 1;
  printPayments(after);
  return 0;
}

// Two ways PayPal itself might stop a double invoice; test what the sandbox actually does.
// All drafts created here are deleted at the end.
async function idemTest(token) {
  const stamp = Date.now();
  const created = [];
  const twice = async (label, body, headers) => {
    const results = [];
    for (const n of ["first", "second"]) {
      const r = await call("POST", "/v2/invoicing/invoices", token, body, { Prefer: "return=representation", ...headers });
      if (r.ok) created.push(invoiceIdFrom(r));
      const detail = r.ok ? `invoice ID: ${created.at(-1)}` : `${r.body?.details?.[0]?.issue ?? r.body?.name ?? ""} - ${r.body?.details?.[0]?.description ?? r.body?.message ?? ""}`;
      console.log(`${label}, ${n} create: HTTP ${r.status}  ${detail}`);
      results.push(r);
    }
    return results;
  };

  // Test 1: PayPal-Request-Id is not documented for Invoicing. Is it honoured anyway?
  const [a, b] = await twice("same PayPal-Request-Id", draftBody("MYR"), { "PayPal-Request-Id": `smoke-idem-${stamp}` });
  if (a.ok && b.ok) console.log(`=> PayPal-Request-Id honoured (same invoice both times): ${invoiceIdFrom(a) === invoiceIdFrom(b) ? "yes" : "no"}`);

  // Test 2: does PayPal refuse a second invoice with the same invoice_number?
  const numbered = draftBody("MYR");
  numbered.detail.invoice_number = `SMOKE-${stamp}`;
  const [c, d] = await twice("same invoice_number", numbered, {});
  if (c.ok) console.log(`=> duplicate invoice_number refused: ${d.ok ? "no" : "yes"}`);

  // Clean up: these drafts were only for the test.
  for (const id of new Set(created)) {
    const del = await call("DELETE", `/v2/invoicing/invoices/${id}`, token);
    console.log(`deleted test draft ${id}: HTTP ${del.status}`);
  }
  return a.ok && c.ok ? 0 : 1;
}

// The app's own PayPal client, keys from the environment only (never printed).
function appPayPal() {
  return createPayPal({ clientId: process.env.PAYPAL_CLIENT_ID ?? "", clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "" });
}
const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const linaRows = () => demoRows(menu).filter((row) => row.buyer === "Lina");

// ONE invoice for the demo buyer Lina (3 x Classic brownies = 54.00 from the menu), sent without email.
async function oneDemoInvoice() {
  const result = await appPayPal().invoiceBuyer({ buyer: "Lina", rows: linaRows(), menu, number: invoiceNumber(newBatchId(), 1) });
  console.log(`invoice id: ${result.invoiceId}`);
  console.log(`status: ${result.status}`);
  console.log(`payer link: ${result.payerLink ?? "(not given)"}`);
  return 0;
}

// The duplicate guard on the REAL sandbox: same number again -> refused -> found by number.
async function dupTest(id) {
  const paypal = appPayPal();
  const invoice = await paypal.getInvoice(id);
  const number = invoice.detail.invoice_number;
  const { body } = invoiceDraft({ buyer: "Lina", rows: linaRows(), menu, number });
  try {
    const extra = await paypal.createDraft(body);
    console.log(`duplicate refused by PayPal: NO (it made draft ${extra.id}; deleting it)`);
    const del = await call("DELETE", `/v2/invoicing/invoices/${extra.id}`, await paypal.token());
    console.log(`deleted: HTTP ${del.status}`);
    return 1;
  } catch (err) {
    if (err.issue !== "DUPLICATE_INVOICE_NUMBER") throw err;
    console.log("duplicate refused by PayPal: yes (DUPLICATE_INVOICE_NUMBER)");
  }
  const found = await paypal.findByNumber(number);
  console.log(`lookup by number finds the same invoice: ${found?.id === id ? "yes" : `NO (${found?.id ?? "nothing"})`}`);
  return found?.id === id ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const withId = { "--check": check, "--qr": qr, "--record-cash": recordCash };
  if (args.includes("--dup-test") && !flag("--dup-test")) {
    console.log("Usage: --dup-test INVOICE_ID");
    return 1;
  }
  try {
    // The app's own code (src/paypal.js): its errors never contain a key or token.
    if (args.includes("--dup-test")) return await dupTest(flag("--dup-test"));
    if (!Object.keys(withId).some((n) => args.includes(n)) && !args.includes("--idem-test")) return await oneDemoInvoice();
    const name = Object.keys(withId).find((n) => args.includes(n));
    if (name && !flag(name)) {
      console.log(`Usage: ${name} INVOICE_ID`);
      return 1;
    }
    const token = await getToken();
    if (!token) return 1;
    if (name) return await withId[name](token, flag(name));
    return await idemTest(token);
  } catch (err) {
    if (err.name === "PayPalError" || err.status) console.log(`FAILED: ${err.message}`);
    else if (err.name === "TimeoutError") console.log("Timed out after 30s waiting for PayPal. Try again.");
    else console.log(`Network error: ${err.cause?.code ?? err.message}`);
    return 1;
  }
}

process.exitCode = await main();
