// PayPal SANDBOX invoices: token (cached), create, send without emailing anyone, look up, and the
// invoice body. Facts proven in the smoke tests of 25 Oct (PLAN.md Sections 5 and 10 #3): MYR works;
// a sent invoice is UNPAID; the payer link is the "payer-view" link in the send reply; a repeated
// invoice_number is refused with 422 DUPLICATE_INVOICE_NUMBER.
// Golden rule: every price comes from menu.json and the total is counted in sen (money.js), never from
// the AI or from a row. Keys come in as arguments (from config.js); no key or token is ever put in an
// error message or a log line.
import { toSen, fromSen } from "./money.js";

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
export const NOT_CONFIGURED = "PayPal is not configured, so invoices can't be sent. Add the PayPal sandbox keys to .env and restart the server.";
const TOKEN_MARGIN_MS = 5 * 60 * 1000; // fetch a new token 5 minutes before the old one expires

export class PayPalError extends Error {
  constructor(message, { status = 502, issue = null, invoiceId = null } = {}) {
    super(message);
    this.name = "PayPalError";
    Object.assign(this, { status, issue, invoiceId });
  }
}

// A refused PayPal reply -> a PayPalError naming PayPal's own issue (never our headers or token).
function refused(action, reply) {
  const body = reply.body ?? {};
  const detail = body.details?.[0];
  const issue = detail?.issue ?? body.name ?? body.error ?? null;
  const description = detail?.description ?? body.message ?? body.error_description ?? "";
  return new PayPalError(`PayPal could not ${action} (HTTP ${reply.status}${issue ? `, ${issue}` : ""})${description ? `: ${description}` : "."}`,
    { status: 502, issue });
}

const sameMoney = (a, b) => {
  try {
    return toSen(a) === toSen(b);
  } catch {
    return false;
  }
};

// "CHATCHING-K3F9Q2ZA-07": the batch changes on every parse and New batch, nn is the buyer's place in
// the batch. 21 characters, within PayPal's 25. PayPal itself refuses a repeat (the last guard).
export function invoiceNumber(batch, n) {
  if (!/^[A-Z0-9]{8}$/.test(String(batch))) throw new RangeError(`Bad batch id ${JSON.stringify(batch)}: use 8 capital letters or digits.`);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new RangeError(`Bad invoice number ${JSON.stringify(n)}: use 1 to 99.`);
  return `CHATCHING-${batch}-${String(n).padStart(2, "0")}`;
}

// One buyer's rows -> { body, total }: the invoice PayPal gets. Names and prices from the menu, the
// currency from the menu setting, the total in sen. Only active, clear rows; anything else is refused.
// No recipient email: nobody is emailed, the seller pastes the payer link into the chat.
export function invoiceDraft({ buyer, rows, menu, number }) {
  const refuse = (message) => Object.assign(new Error(message), { status: 400 });
  const name = String(buyer ?? "").trim().slice(0, 100) || "this buyer";
  if (!Array.isArray(rows) || !rows.length) throw refuse(`${name} has no items to invoice.`);
  let sen = 0;
  const items = rows.map((row) => {
    if (row.orderStatus === "cancelled") throw refuse(`${name}'s order is cancelled, so it can't be invoiced.`);
    if (row.orderStatus !== "active" || row.unclear) throw refuse(`${name} needs a check before invoicing.`);
    const item = menu.items.find((i) => i.id === row.itemId);
    if (!item) throw refuse(`"${row.itemId}" is not on the menu, so ${name} can't be invoiced.`);
    if (!(Number.isInteger(row.qty) && row.qty >= 1 && row.qty <= 99)) throw refuse(`${name}'s quantity ${row.qty} is not 1 to 99.`);
    sen += toSen(item.price) * row.qty;
    return { name: item.name, quantity: String(row.qty), unit_amount: { currency_code: menu.currency, value: fromSen(toSen(item.price)) }, unit_of_measure: "QUANTITY" };
  });
  return {
    total: fromSen(sen),
    body: {
      detail: {
        currency_code: menu.currency,
        invoice_number: number,
        note: `Thank you for your order, ${name}!`, // shown to the buyer
        memo: `Chat order from ${name} (ChatChing).`, // seller-only
      },
      items,
    },
  };
}

// PayPal's generate-qr-code reply -> the PNG bytes, or null. The docs only say "a PNG image in Base64";
// the sandbox sent multipart/form-data with the Base64 text in a part named "image" (smoke test, 25 Oct).
// Every Base64 PNG starts with "iVBORw0KGgo" (the encoded PNG signature), so it is read from there.
// The bytes are checked for the PNG signature, so a changed format gives null, never a broken image.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngFromQrReply(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""));
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;
  const text = buffer.toString("utf8");
  const start = text.indexOf("iVBORw0KGgo");
  if (start < 0) return null;
  const png = Buffer.from(text.slice(start).match(/^[A-Za-z0-9+/=\r\n]+/)[0].replace(/\s/g, ""), "base64");
  return png.subarray(0, 8).equals(PNG_SIGNATURE) ? png : null;
}

export function createPayPal({ clientId, clientSecret, baseUrl = SANDBOX_BASE, fetch = globalThis.fetch, now = Date.now, timeoutMs = 30_000 }) {
  if (baseUrl !== SANDBOX_BASE) throw new Error(`ChatChing only talks to the PayPal sandbox (${SANDBOX_BASE}), not ${baseUrl}.`);
  let cached = null; // { token, expiresAt }
  let pending = null; // a token request in flight, shared by everyone who asks meanwhile

  // raw: the reply is not JSON (the QR code) -> body is the bytes, json is PayPal's error (if any).
  async function request(path, init, raw = false) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new PayPalError(`PayPal took too long to answer (over ${timeoutMs / 1000} s). Please try again.`, { status: 504 });
      }
      throw new PayPalError(`Can't reach PayPal (${err?.cause?.code ?? err?.message ?? "network error"}). Check the internet connection.`);
    }
    if (raw) {
      const bytes = Buffer.from(await res.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {}
      return { status: res.status, ok: res.ok, bytes, body: json };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {} // an empty reply is fine
    return { status: res.status, ok: res.ok, body };
  }

  async function token() {
    if (!clientId || !clientSecret) throw new PayPalError(NOT_CONFIGURED, { status: 503 });
    if (cached && now() < cached.expiresAt) return cached.token;
    pending ??= (async () => {
      const reply = await request("/v1/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      if (reply.status === 401) {
        throw new PayPalError("PayPal refused the keys (HTTP 401). Check that PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET come from the same sandbox app.");
      }
      if (!reply.ok || typeof reply.body?.access_token !== "string") throw refused("give a token", reply);
      const life = (Number(reply.body.expires_in) || 0) * 1000;
      cached = { token: reply.body.access_token, expiresAt: now() + life - Math.min(TOKEN_MARGIN_MS, life / 2) };
      return cached.token;
    })().finally(() => (pending = null));
    return pending;
  }

  // An API call with the token. A 401 means the token went stale (e.g. app permissions changed):
  // drop it and try once more with a fresh one.
  async function api(method, path, body, headers = {}, raw = false) {
    for (let attempt = 1; ; attempt++) {
      const reply = await request(path, {
        method,
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, raw);
      if (reply.status !== 401 || attempt > 1) return reply;
      cached = null;
    }
  }

  async function getInvoice(id) {
    const reply = await api("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    if (!reply.ok) throw refused(`find invoice ${id}`, reply);
    return reply.body;
  }

  async function createDraft(body) {
    const reply = await api("POST", "/v2/invoicing/invoices", body, { Prefer: "return=representation" });
    if (!reply.ok) throw refused("create the invoice", reply);
    // Without the representation PayPal only sends a link to the new invoice.
    return reply.body?.id ? reply.body : getInvoice(String(reply.body?.href ?? "").split("/").pop());
  }

  // Sends WITHOUT emailing the buyer or the seller. -> the payer link, or null if PayPal didn't give one.
  async function sendInvoice(id) {
    const reply = await api("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { send_to_recipient: false, send_to_invoicer: false });
    if (!reply.ok) throw refused(`send invoice ${id}`, reply);
    const links = [reply.body, ...(reply.body?.links ?? [])];
    return links.find((link) => link?.rel === "payer-view")?.href ?? null;
  }

  // Records a payment made outside PayPal (cash or bank transfer) -> the invoice becomes MARKED_AS_PAID.
  // The caller passes the amount from the saved invoice; it is never typed.
  async function recordPayment(id, { method, date, amount, note }) {
    const reply = await api("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, { method, payment_date: date, amount, note });
    if (!reply.ok) throw refused(`record the payment for invoice ${id}`, reply);
    return reply.body;
  }

  // The invoice's QR code (Step 7, PLAN.md Section 10 #3b) as PNG bytes. It opens the invoice for paying;
  // the invoice must be sent first. (What the code holds: PLAN.md Step 10c, scripts/decode-qr.mjs.)
  async function qrCode(id, size = 300) {
    const reply = await api("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/generate-qr-code`, { width: size, height: size, action: "pay" }, {}, true);
    if (!reply.ok) throw refused(`make the QR code for invoice ${id}`, reply);
    const png = pngFromQrReply(reply.bytes);
    if (!png) throw new PayPalError(`PayPal's QR code reply for invoice ${id} had no picture in it.`);
    return png;
  }

  // The invoice with exactly this number (full details), or null.
  async function findByNumber(number) {
    const reply = await api("POST", "/v2/invoicing/search-invoices?page=1&page_size=20&total_required=false", { invoice_number: number });
    if (!reply.ok) throw refused(`look up invoice ${number}`, reply);
    const match = (reply.body?.items ?? []).find((inv) => inv?.detail?.invoice_number === number);
    return match ? getInvoice(match.id) : null;
  }

  // One buyer -> a sent invoice: { invoiceId, invoiceNumber, status, payerLink, reused }.
  // With a saved invoiceId (a draft whose send failed) it carries on with that invoice. If PayPal says
  // the number already exists (an earlier click that timed out), it finds THAT invoice instead of
  // making a new one. PayPal's total must equal the menu's total, or nothing is sent.
  async function invoiceBuyer({ buyer, rows, menu, number, invoiceId = null }) {
    const { body, total } = invoiceDraft({ buyer, rows, menu, number });
    let invoice;
    let reused = Boolean(invoiceId);
    if (invoiceId) invoice = await getInvoice(invoiceId);
    else {
      try {
        invoice = await createDraft(body);
      } catch (err) {
        if (err.issue !== "DUPLICATE_INVOICE_NUMBER") throw err;
        invoice = await findByNumber(number);
        if (!invoice) throw new PayPalError(`PayPal says invoice ${number} already exists, but it could not be found. Please try again later.`, { status: 409 });
        reused = true;
      }
    }

    const theirs = invoice.amount ?? {};
    if (theirs.currency_code !== menu.currency || !sameMoney(theirs.value, total)) {
      throw new PayPalError(`PayPal's total (${theirs.value} ${theirs.currency_code}) is not the menu's (${total} ${menu.currency}), so invoice ${number} was not sent.`,
        { status: 409, invoiceId: invoice.id });
    }

    let status = invoice.status;
    let payerLink = invoice.detail?.metadata?.recipient_view_url ?? null;
    if (status === "DRAFT") {
      try {
        const link = await sendInvoice(invoice.id);
        const sent = await getInvoice(invoice.id);
        status = sent.status;
        payerLink = link ?? sent.detail?.metadata?.recipient_view_url ?? null;
      } catch (err) {
        err.invoiceId ??= invoice.id; // the draft exists: next time, carry on with it
        throw err;
      }
    }
    return { invoiceId: invoice.id, invoiceNumber: number, status, payerLink, reused };
  }

  return { token, getInvoice, createDraft, sendInvoice, findByNumber, invoiceBuyer, recordPayment, qrCode };
}
