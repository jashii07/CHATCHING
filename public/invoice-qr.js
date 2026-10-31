// Reading an invoice out of a scanned QR or the typed box (Step 10c). Pure: no network, no page, no clock.
// It lives in public/ because BOTH sides use it: the phone checks a scan first, so a stranger's QR never
// leaves the device; the server checks again, because it never trusts what a browser sends.
// What PayPal's QR holds (decoded in Step 7 from two real sandbox codes):
//   https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1
export const NOT_OUR_QR = "This isn't a ChatChing invoice QR.";

const PAYPAL_SANDBOX = "www.sandbox.paypal.com";
const INVOICE_ID = "INV2(?:-[A-Z0-9]{4}){4}";
const ID_ONLY = new RegExp(`^${INVOICE_ID}$`);
const NUMBER_ONLY = /^CHATCHING-[A-Z0-9]{12}-\d{2,3}$/; // src/paypal.js invoiceNumber()
const PAYER_PAGE = new RegExp(`^/invoice/payerView/details/(${INVOICE_ID})$`);
const MAX_TEXT = 2000; // PayPal's QR holds 86 characters

// Text -> a URL on PayPal's sandbox itself, or null. Comparing the parsed host (with no login part and no
// port) is what stops look-alikes such as www.sandbox.paypal.com.evil.example or ...@evil.example.
function sandboxUrl(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const clean = url.protocol === "https:" && url.host === PAYPAL_SANDBOX && !url.username && !url.password;
  return clean ? url : null;
}

// A scanned QR counts only if it is a PayPal sandbox payer page with a well-formed invoice id. -> id or null.
export function invoiceIdFromQr(text) {
  return sandboxUrl(text)?.pathname.match(PAYER_PAGE)?.[1] ?? null;
}

// Is this an invoice id or a ChatChing invoice number, exactly? The server's check of what the page sent.
export const isInvoiceRef = (value) => typeof value === "string" && (ID_ONLY.test(value) || NUMBER_ONLY.test(value));

// The payer link from PayPal's send reply, shown in the table: .../invoice/p/#INV2-...
function invoiceIdFromPayerLink(text) {
  const url = sandboxUrl(text);
  const id = url?.hash.slice(1);
  return url?.pathname === "/invoice/p/" && ID_ONLY.test(id) ? id : null;
}

// The fallback box: the invoice id or number (any case), or a pasted QR or payer link. -> id, number or null.
export function invoiceRefFromTyped(text) {
  if (typeof text !== "string") return null;
  const link = invoiceIdFromQr(text) ?? invoiceIdFromPayerLink(text);
  if (link) return link;
  const typed = text.trim().toUpperCase();
  return isInvoiceRef(typed) ? typed : null;
}
