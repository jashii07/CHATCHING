// Smoke test: create + send a PayPal SANDBOX invoice without emailing anyone, and print the payer link.
// Run:   node --env-file=.env scripts/smoke-invoice.mjs [--to buyer@personal.example.com]
// Check: node --env-file=.env scripts/smoke-invoice.mjs --check INVOICE_ID
// Never prints the token, client ID or secret.

const BASE = "https://api-m.sandbox.paypal.com";
const CURRENCIES = ["MYR", "USD"]; // try MYR first, fall back to USD

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
    detail: { currency_code: currency, note: "Smoke test invoice from Chat-to-Checkout." },
    items: [
      { name: "Brownies (box of 6)", quantity: "2", unit_amount: money("15.00") },
      { name: "Kek batik (1 slab)", quantity: "1", unit_amount: money("25.00") },
    ],
  };
  if (buyerEmail) invoice.primary_recipients = [{ billing_info: { email_address: buyerEmail } }];
  return invoice;
}

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

async function check(id) {
  const token = await getToken();
  if (!token) return 1;
  const inv = await showStatus(token, id, "check");
  if (!inv) return 1;
  console.log(`recipient_view_url: ${inv.detail?.metadata?.recipient_view_url ?? "(not present)"}`);
  for (const p of inv.payments?.transactions ?? []) {
    console.log(`payment: ${p.amount?.value} ${p.amount?.currency_code}  method: ${p.method}  date: ${p.payment_date}`);
  }
  return 0;
}

async function createAndSend(buyerEmail) {
  const token = await getToken();
  if (!token) return 1;

  // Step a: create a draft, MYR first, then USD.
  let id = null;
  let currency = null;
  for (const c of CURRENCIES) {
    const r = await call("POST", "/v2/invoicing/invoices", token, draftBody(c, buyerEmail), {
      Prefer: "return=representation",
    });
    if (r.ok) {
      // With return=representation PayPal returns the invoice; otherwise only a link to it.
      id = r.body?.id ?? r.body?.href?.split("/").pop();
      currency = c;
      break;
    }
    printError(`create draft (${c})`, r.status, r.body);
    if (isNotEnabled(r.status, r.body)) {
      console.log("STOP: Invoicing looks disabled for this sandbox account, so another currency won't help.");
      return 1;
    }
    console.log(`--> ${c} failed, trying next currency...`);
  }
  if (!id) return 1;
  console.log(`currency that worked: ${currency}`);
  if (!(await showStatus(token, id, "after create"))) return 1;

  // Step b: send without emailing the buyer or me.
  const s = await call("POST", `/v2/invoicing/invoices/${id}/send`, token, {
    send_to_recipient: false,
    send_to_invoicer: false,
  });
  if (!s.ok) {
    printError("send invoice", s.status, s.body);
    return 1;
  }
  console.log(`send response: HTTP ${s.status}  rel: ${s.body?.rel ?? "-"}  href: ${s.body?.href ?? "-"}`);

  // Step c: status after send, and the payer link.
  const inv = await showStatus(token, id, "after send");
  if (!inv) return 1;
  console.log(`recipient_view_url: ${inv.detail?.metadata?.recipient_view_url ?? "(not present)"}`);
  console.log(`Re-check later: node --env-file=.env scripts/smoke-invoice.mjs --check ${id}`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    if (args.includes("--check")) {
      const id = flag("--check");
      if (!id) {
        console.log("Usage: --check INVOICE_ID");
        return 1;
      }
      return await check(id);
    }
    return await createAndSend(flag("--to"));
  } catch (err) {
    if (err.name === "TimeoutError") console.log("Timed out after 30s waiting for PayPal. Try again.");
    else console.log(`Network error: ${err.cause?.code ?? err.message}`);
    return 1;
  }
}

process.exitCode = await main();
