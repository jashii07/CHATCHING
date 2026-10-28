// An in-memory FAKE PayPal sandbox for the tests and the browser checks: no network, no keys, no real
// invoices. It copies what the real sandbox did in the smoke tests of 25 Oct (PLAN.md Sections 5 and 10):
// a created invoice is a DRAFT; sending it makes it UNPAID and replies with the "payer-view" link; a
// repeated invoice_number is refused with 422 DUPLICATE_INVOICE_NUMBER. Totals are worked out in sen.
// Lives in scripts/, not test/, because node --test would run every .js file under test/ as a test.
import { toSen, fromSen } from "../src/money.js";

const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

export function fakePayPal({ expiresIn = 32400 } = {}) {
  const invoices = new Map(); // id -> invoice
  const calls = []; // { kind, method, path, body }
  const failures = []; // { kind, status, body }, used once each
  const validTokens = new Set();
  let tokenCount = 0;
  let idCount = 0;
  let gate = null; // while set, creating an invoice waits (to test locks)
  let wrongTotal = false;

  const payerLink = (id) => `https://www.sandbox.paypal.com/invoice/p/#${id}`;

  function total(body) {
    const sen = (body.items ?? []).reduce((sum, item) => sum + toSen(item.unit_amount.value) * Number(item.quantity), 0);
    return { currency_code: body.detail.currency_code, value: fromSen(sen + (wrongTotal ? 1 : 0)) };
  }

  async function fetch(url, init = {}) {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    const kind = pathname === "/v1/oauth2/token" ? "token"
      : pathname === "/v2/invoicing/invoices" ? "create"
      : pathname === "/v2/invoicing/search-invoices" ? "search"
      : pathname.endsWith("/send") ? "send"
      : "get";
    calls.push({ kind, method, path: pathname, body });

    const auth = init.headers?.Authorization ?? "";
    const failure = failures.findIndex((f) => f.kind === kind);
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      if (f.throws) throw f.throws;
      return json(f.status, f.body);
    }

    if (kind === "token") {
      if (!auth.startsWith("Basic ")) return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
      const token = `fake-token-${++tokenCount}`;
      validTokens.add(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: expiresIn });
    }
    if (!validTokens.has(auth.replace(/^Bearer /, ""))) {
      return json(401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials." });
    }

    if (kind === "create") {
      if (gate) await gate;
      const number = body.detail?.invoice_number;
      if ([...invoices.values()].some((inv) => inv.detail.invoice_number === number)) {
        return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ field: "/detail/invoice_number", issue: "DUPLICATE_INVOICE_NUMBER", description: "Invoice number must be unique." }] });
      }
      const id = `INV2-FAKE-${String(++idCount).padStart(4, "0")}`;
      const invoice = { id, status: "DRAFT", detail: { ...body.detail, metadata: {} }, items: body.items, amount: total(body) };
      invoices.set(id, invoice);
      return json(201, structuredClone(invoice));
    }
    if (kind === "search") {
      const items = [...invoices.values()].filter((inv) => inv.detail.invoice_number.includes(body.invoice_number ?? ""));
      return json(200, { total_items: items.length, items: structuredClone(items) });
    }
    const id = pathname.split("/")[4];
    const invoice = invoices.get(id);
    if (!invoice) return json(404, { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." });
    if (kind === "send") {
      if (invoice.status !== "DRAFT") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CANNOT_SEND_INVOICE" }] });
      invoice.status = "UNPAID";
      invoice.detail.metadata.recipient_view_url = payerLink(id);
      return json(200, { href: payerLink(id), rel: "payer-view", method: "GET" });
    }
    return json(200, structuredClone(invoice));
  }

  return {
    fetch,
    invoices,
    calls,
    count: (kind) => calls.filter((c) => c.kind === kind).length,
    // The next call of this kind fails once: with a PayPal reply, or by throwing (a network error).
    failNext: (kind, status, body = {}) => failures.push({ kind, status, body }),
    throwNext: (kind, error) => failures.push({ kind, throws: error }),
    expireTokens: () => validTokens.clear(),
    // While held, creating an invoice waits; returns release().
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      return () => { gate = null; release(); };
    },
    // PayPal's total comes out 1 sen more than ours (to test the total check).
    setWrongTotal: (on) => (wrongTotal = on),
    // An invoice already at PayPal (e.g. made by an earlier click that timed out).
    add(invoice) {
      const id = invoice.id ?? `INV2-FAKE-${String(++idCount).padStart(4, "0")}`;
      invoices.set(id, { status: "DRAFT", items: [], ...invoice, id, detail: { metadata: {}, ...invoice.detail } });
      if (invoice.status && invoice.status !== "DRAFT") invoices.get(id).detail.metadata.recipient_view_url = payerLink(id);
      return id;
    },
  };
}
