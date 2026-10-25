// Smoke test: proves the PayPal sandbox keys work by getting a token and creating a 5.00 USD order.
// Run: node --env-file=.env scripts/smoke-paypal.mjs
// Never prints the token, client ID or secret.

const BASE = "https://api-m.sandbox.paypal.com";

const HINTS = {
  400: "PayPal did not accept the request body. The order data may be malformed.",
  401: "PayPal rejected the keys. Check that PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are both from the SAME Sandbox app (not Live), with no extra spaces or quotes.",
  403: "The keys work but this app is not allowed to do this. Check the app's features in the PayPal developer dashboard.",
  422: "PayPal understood the request but refused it for a business reason. Read the issue details above.",
  500: "PayPal's sandbox had an internal problem. Wait a minute and try again.",
  503: "PayPal's sandbox is temporarily unavailable. Wait a minute and try again.",
};

function fail(step, status, body) {
  console.log(`FAILED at: ${step}`);
  console.log(`HTTP status: ${status}`);
  if (body) {
    // PayPal errors use either {error, error_description} (auth) or {name, message, details} (orders).
    const name = body.error ?? body.name;
    const message = body.error_description ?? body.message;
    if (name) console.log(`PayPal error: ${name}`);
    if (message) console.log(`PayPal message: ${message}`);
    for (const d of body.details ?? []) {
      console.log(`  issue: ${d.issue} - ${d.description ?? ""}`);
    }
    if (body.debug_id) console.log(`debug_id: ${body.debug_id}`);
  }
  console.log(`Likely cause: ${HINTS[status] ?? "Unexpected error. Check the PayPal message above."}`);
  process.exit(1);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
const missing = [!clientId && "PAYPAL_CLIENT_ID", !clientSecret && "PAYPAL_CLIENT_SECRET"].filter(Boolean);
if (missing.length) {
  console.log("token OK: no");
  console.log(`Missing in .env: ${missing.join(", ")}`);
  console.log("Likely cause: the value is empty in .env, or the script was not run with --env-file=.env.");
  process.exit(1);
}

// Step a: OAuth access token (client credentials grant).
let tokenRes;
try {
  tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
} catch (err) {
  console.log("token OK: no");
  console.log(`Network error: ${err.cause?.code ?? err.message}`);
  console.log("Likely cause: no internet connection, or a firewall/proxy is blocking api-m.sandbox.paypal.com.");
  process.exit(1);
}
const tokenBody = await readJson(tokenRes);
if (!tokenRes.ok || !tokenBody?.access_token) {
  console.log("token OK: no");
  fail("get access token", tokenRes.status, tokenBody);
}
console.log("token OK: yes");

// Step b: create a 5.00 USD order with intent CAPTURE.
const orderRes = await fetch(`${BASE}/v2/checkout/orders`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${tokenBody.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }],
  }),
});
const order = await readJson(orderRes);
if (!orderRes.ok) fail("create order", orderRes.status, order);

// Step c: print only the safe fields.
console.log(`order ID: ${order.id}`);
console.log(`order status: ${order.status}`);
console.log(`approve link: ${order.links?.find((l) => l.rel === "approve")?.href ?? "(not found)"}`);
