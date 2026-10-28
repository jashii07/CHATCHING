// Invoice status from PayPal (Step 6): ask PayPal about every OPEN invoice and save what it says.
// Polling pages call this every 20 s, so it protects PayPal (and our rate limit):
//   - a 10-second cache: a check within 10 s of the last one makes no PayPal call;
//   - one round at a time: tabs asking at the same moment share it.
// Final statuses (Paid, Paid (cash/bank), Cancelled/Refunded) are not asked again; a draft whose send
// failed is the Send button's job, not this one's.
import { mapPayPalStatus } from "./orders.js";
import { PayPalError } from "./paypal.js";

export const CACHE_MS = 10_000;
const FINAL = ["Paid", "Paid (cash/bank)", "Cancelled/Refunded"];

export function createStatusChecker({ store, paypal, now = Date.now, log = console.log }) {
  let lastCheck = -Infinity;
  let pending = null;

  async function round() {
    const batch = store.batch();
    const open = new Map(); // invoiceId -> buyer, in table order
    for (const row of store.rows()) {
      if (row.invoiceId && row.invoiceStatus !== "Draft" && !FINAL.includes(row.invoiceStatus) && !open.has(row.invoiceId)) {
        open.set(row.invoiceId, row.buyer);
      }
    }
    const result = { changed: [], failed: [], checked: open.size, cached: false };
    const answers = [];
    // One after another: gentle on PayPal, and a failure only affects its own buyer.
    for (const [id, buyer] of open) {
      try {
        answers.push({ id, buyer, status: mapPayPalStatus((await paypal.getInvoice(id)).status) });
      } catch (err) {
        if (!(err instanceof PayPalError)) log(`ERROR checking ${buyer}'s invoice: ${err.stack ?? err}`);
        result.failed.push({ buyer, reason: err instanceof PayPalError ? err.message : "Something went wrong on the server." });
      }
    }
    lastCheck = now();
    // New batch or Reset while we waited: these answers belong to rows that are gone.
    if (store.batch() !== batch) return result;
    for (const { id, buyer, status } of answers) {
      // Never downgrade a final status: a cash payment recorded while we waited must stay paid.
      const rows = store.rows().filter((row) => row.invoiceId === id && row.invoiceStatus !== status && !FINAL.includes(row.invoiceStatus));
      if (!rows.length) continue;
      result.changed.push({ buyer, from: rows[0].invoiceStatus, to: status });
      store.replaceMany(rows.map((row) => ({ ...row, invoiceStatus: status })));
    }
    return result;
  }

  return {
    // -> { changed: [{ buyer, from, to }], failed: [{ buyer, reason }], checked, cached }
    async refresh() {
      if (pending) return pending;
      if (now() - lastCheck < CACHE_MS) return { changed: [], failed: [], checked: 0, cached: true };
      pending = round().finally(() => (pending = null));
      return pending;
    },
    // Invoices were just sent: their statuses are fresh, so the next poll may wait for the cache.
    markFresh: () => (lastCheck = now()),
  };
}
