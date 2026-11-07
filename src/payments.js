// Recording a cash or bank-transfer payment (Step 6, PLAN.md Section 10 #3a): the seller says HOW the
// buyer paid; the AMOUNT is the full total of the saved invoice at PayPal, which must equal the menu's
// total (money.js, sen). It is never typed by the seller and never comes from the AI.
// Recording twice is refused: our saved status, a per-invoice lock, and PayPal's own fresh status.
import { mapPayPalStatus } from "./orders.js";
import { invoiceDraft, PayPalError } from "./paypal.js";
import { toSen } from "./money.js";

export const METHODS = { CASH: "Cash", BANK_TRANSFER: "Bank transfer" };
const refuse = (status, message) => Object.assign(new Error(message), { status });

// menu: the menu, or a function giving the visitor's menu as it is now ("My menu", 7 Nov).
export function createPaymentRecorder({ store, paypal, menu: menuOf, now = Date.now }) {
  const menuNow = typeof menuOf === "function" ? menuOf : () => menuOf;
  const busy = new Set(); // invoice ids whose payment is being recorded right now

  // -> { buyer, method, amount } once PayPal says MARKED_AS_PAID; refusals throw with a 4xx status.
  async function record(invoiceId, method) {
    if (typeof method !== "string" || !Object.hasOwn(METHODS, method)) throw refuse(400, 'Send { "method": "CASH" } or { "method": "BANK_TRANSFER" }.');
    const rows = store.rows().filter((row) => row.invoiceId === invoiceId && row.orderStatus === "active");
    if (!rows.length) throw refuse(404, `No invoice ${JSON.stringify(invoiceId)} in these orders.`);
    const { buyer } = rows[0];
    const ourStatus = rows[0].invoiceStatus;
    if (ourStatus.startsWith("Paid")) throw refuse(409, `${buyer}'s invoice is already paid, so nothing was recorded.`);
    if (ourStatus === "Draft") throw refuse(400, `${buyer}'s invoice was never sent. Send it first.`);
    if (busy.has(invoiceId)) throw refuse(409, `${buyer}'s payment is being recorded right now.`);
    busy.add(invoiceId);
    const batch = store.batch();
    const save = (status) => {
      if (store.batch() !== batch) return; // New batch or Reset while we waited
      store.replaceMany(store.rows().filter((row) => row.invoiceId === invoiceId).map((row) => ({ ...row, invoiceStatus: status })));
    };
    const menu = menuNow();
    try {
      // PayPal's saved invoice is the source of the amount, and of the truth about its status.
      const invoice = await paypal.getInvoice(invoiceId);
      const theirs = mapPayPalStatus(invoice.status);
      if (theirs.startsWith("Paid")) {
        save(theirs);
        throw refuse(409, `${buyer}'s invoice is already paid, so nothing was recorded.`);
      }
      if (theirs === "Part paid") throw refuse(409, `${buyer} has paid part of the invoice. Record the rest in PayPal itself.`);
      if (theirs === "Cancelled/Refunded") {
        save(theirs);
        throw refuse(409, `${buyer}'s invoice is cancelled at PayPal, so nothing was recorded.`);
      }
      if (invoice.status !== "UNPAID" && invoice.status !== "SENT") throw refuse(409, `${buyer}'s invoice is ${invoice.status} at PayPal, so nothing was recorded.`);

      // Check first, charge second: the saved invoice's total must be the menu's total.
      const { total } = invoiceDraft({ buyer, rows, menu, number: rows[0].invoiceNumber });
      const amount = invoice.amount ?? {};
      let same = false;
      try {
        same = amount.currency_code === menu.currency && toSen(amount.value) === toSen(total);
      } catch {}
      if (!same) {
        throw refuse(409, `PayPal's total for ${buyer} (${amount.value} ${amount.currency_code}) is not the menu's (${total} ${menu.currency}), so nothing was recorded.`);
      }

      await paypal.recordPayment(invoiceId, {
        method,
        date: new Date(now()).toISOString().slice(0, 10), // UTC date: never "in the future" for PayPal
        amount: { currency_code: amount.currency_code, value: amount.value },
        note: `${METHODS[method]} recorded in ChatChing.`,
      });
      save(mapPayPalStatus((await paypal.getInvoice(invoiceId)).status));
      return { buyer, method, amount: amount.value };
    } catch (err) {
      if (err instanceof PayPalError) throw Object.assign(err, { status: 502 });
      throw err;
    } finally {
      busy.delete(invoiceId);
    }
  }

  return { record, isBusy: () => busy.size > 0 };
}
