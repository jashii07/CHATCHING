// The pickup scan's server side (Step 10c): which invoice was scanned, has it been paid, and was it collected.
// It looks ONLY in this visitor's table, and asks PayPal through src/status.js, so the 10-second cache and
// the one-round-at-a-time rule still protect PayPal. "Collected" is our own mark: it lives on the rows and
// is never sent to PayPal. A refusal is { notice }, friendly words with status 200, so the browser logs no
// red line. The words come from here, not the page, so a test can check them exactly.
import { toSen, fromSen, formatMoney } from "./money.js";
import { shortName } from "./messages.js";
import { FINAL } from "./status.js";
import { NOT_OUR_QR, isInvoiceRef } from "../public/invoice-qr.js";

export const NOT_IN_ORDERS = "Not in your orders.";
const NOT_YOURS = { notice: NOT_IN_ORDERS, notInOrders: true };

const isPaid = (status) => String(status).startsWith("Paid"); // Paid, or Paid (cash/bank)

function stateOf(status) {
  if (isPaid(status)) return "paid";
  if (status === "Part paid") return "part-paid";
  if (status === "Cancelled/Refunded") return "cancelled";
  return "unpaid";
}

// One invoice's rows -> what the scan screen shows.
function view(rows, menu, { cached = false, unreachable = false, changed = [] } = {}) {
  const { invoiceId, invoiceNumber, buyer, invoiceStatus: status } = rows[0];
  const items = rows.map((row) => ({ qty: row.qty, name: shortName(row.itemName) }));
  const total = fromSen(rows.reduce((sum, row) => sum + toSen(row.lineTotal), 0));
  const amount = formatMoney(total, menu.currency); // Intl's no-break space keeps the symbol and the number together
  const detail = `${buyer}, ${items.map((item) => `${item.qty} x ${item.name}`).join(", ")}`;
  const state = unreachable ? "unknown" : stateOf(status);
  const title = {
    paid: `Paid: ${detail}`,
    unpaid: `Not paid yet: ${amount}`,
    "part-paid": `Part paid: ${amount} in total`,
    cancelled: `Cancelled or refunded: ${amount}`,
    unknown: "Couldn't check with PayPal",
  }[state];
  return {
    invoiceId, invoiceNumber, buyer, items, total, status, state, title, detail,
    paid: state === "paid",
    collected: rows.every((row) => row.collected === true),
    cached, changed,
  };
}

export function createPickup({ store, status, menu }) {
  // An invoice covers the buyer's active rows; a scan can name it by id, a typed box also by number.
  const rowsOf = (ref) => store.rows().filter((row) => row.orderStatus === "active" && (row.invoiceId === ref || row.invoiceNumber === ref));

  return {
    // -> the view above, or { notice }.
    async check(ref) {
      if (!isInvoiceRef(ref)) return { notice: NOT_OUR_QR };
      const rows = rowsOf(ref);
      if (!rows.length) return NOT_YOURS;
      const { buyer, invoiceStatus } = rows[0];
      if (invoiceStatus === "Draft") return { notice: `${buyer}'s invoice was never sent. Send it first.` };
      if (FINAL.includes(invoiceStatus)) return view(rows, menu); // settled: PayPal needs no asking
      const { cached, failed, changed } = await status.refresh();
      const fresh = rowsOf(ref); // New batch or Reset may have happened while PayPal answered
      if (!fresh.length) return NOT_YOURS;
      // Handing over goods depends on this answer, so a failed check never says "unpaid" or "paid".
      return view(fresh, menu, { cached, changed, unreachable: failed.some((f) => f.buyer === buyer) });
    },

    // undo: take the mark back, whatever the invoice's status. -> the view above, or { notice }.
    collected(ref, { undo = false } = {}) {
      if (!isInvoiceRef(ref)) return { notice: NOT_OUR_QR };
      const rows = rowsOf(ref);
      if (!rows.length) return NOT_YOURS;
      const { buyer, invoiceStatus } = rows[0];
      if (!undo && !isPaid(invoiceStatus)) return { notice: `${buyer}'s invoice isn't paid yet, so it can't be marked Collected.` };
      store.replaceMany(rows.map(({ collected, ...row }) => (undo ? row : { ...row, collected: true })));
      return view(rowsOf(ref), menu);
    },
  };
}
