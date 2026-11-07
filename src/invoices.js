// Sending invoices: one per buyer whose active rows are all clear, never two (PLAN.md Section 10 #3c).
// The guards, in order:
//   1. Only clear, active buyers (groupByBuyer: cancelled rows are left out, unclear buyers refused).
//   2. The store: a buyer whose rows already have a sent invoice is skipped.
//   3. A per-buyer lock while their invoice is being made, so a double-click can't make two.
//   4. The invoice number CHATCHING-{batch}-{nn}: PayPal refuses a repeat, and src/paypal.js then
//      finds that invoice instead of making a new one.
// A send that fails after the draft was made keeps the draft's id, so the next click carries on with it.
import { buyerGroups, groupByBuyer, mapPayPalStatus } from "./orders.js";
import { INVOICE_DIFFERS, invoiceNumber, PayPalError } from "./paypal.js";

const key = (buyer) => String(buyer ?? "").trim().toLowerCase();
const refuse = (status, message) => Object.assign(new Error(message), { status });
// Invoice numbers use PayPal's full 25 characters, so a batch has room for buyer 01 to 99.
const MAX_BUYERS = 99;
const BATCH_FULL = "A batch holds up to 99 buyers. Send these, then start a New batch.";

// spend(): asked just before each buyer goes to PayPal, so the rate limit counts buyers sent, not requests.
// -> null to go ahead, or how many ms until the next one is allowed.
// menu: the menu, or a function giving the visitor's menu as it is now ("My menu", 7 Nov).
export function createInvoicer({ store, paypal, menu, log = console.log }) {
  const menuNow = typeof menu === "function" ? menu : () => menu;
  const busy = new Set(); // buyers whose invoice is being made right now

  // One buyer: -> { sent } or { skipped } or { failed }. Never throws for PayPal problems.
  async function invoiceOne(buyer, nn, spend) {
    const k = key(buyer);
    if (busy.has(k)) return { skipped: "Being invoiced right now." };
    if (store.rows().some((row) => row.orderStatus === "active" && key(row.buyer) === k && row.invoiceId && row.invoiceStatus !== "Draft")) return { skipped: "Already invoiced." };
    const waitMs = spend();
    if (waitMs !== null) return { limited: waitMs };
    busy.add(k);
    const batch = store.batch();
    const rows = store.rows().filter((row) => row.orderStatus === "active" && key(row.buyer) === k);
    const saved = rows.find((row) => row.invoiceId);
    try {
      const number = saved?.invoiceNumber ?? invoiceNumber(batch, nn);
      const result = await paypal.invoiceBuyer({ buyer, rows, menu: menuNow(), number, invoiceId: saved?.invoiceId ?? null });
      if (store.batch() !== batch) throw new Error("the batch changed while invoicing"); // can't happen: routes wait
      store.replaceMany(rows.map(({ sendUnknown, ...row }) => ({
        ...row, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber,
        payerLink: result.payerLink, invoiceStatus: mapPayPalStatus(result.status),
      })));
      return { sent: { buyer, invoiceNumber: result.invoiceNumber, reused: result.reused } };
    } catch (err) {
      // PayPal holds this number for other items: never link it. The row says why, and the seller can act on it.
      if (err.issue === INVOICE_DIFFERS) {
        store.replaceMany(rows.map(({ sendUnknown, ...row }) => ({ ...row, unclear: true, reason: [row.reason, err.message].filter(Boolean).join(" ") })));
        return { failed: err.message };
      }
      // No answer: the invoice may exist, under the number these rows would get. Their items stay as they are until
      // the next send finds out, or the seller starts a New batch.
      if (err.unknown && !err.invoiceId && !saved && store.batch() === batch) store.replaceMany(rows.map((row) => ({ ...row, sendUnknown: true })));
      // A draft exists at PayPal: remember it, so the next click sends it instead of making another.
      if (err.invoiceId && store.batch() === batch) {
        store.replaceMany(rows.map((row) => ({
          ...row, invoiceId: err.invoiceId, invoiceNumber: saved?.invoiceNumber ?? invoiceNumber(batch, nn), payerLink: null, invoiceStatus: "Draft",
        })));
      }
      // PayPal's own words are safe to show (src/paypal.js never puts a key or token in them).
      if (err instanceof PayPalError) return { failed: err.message };
      log(`ERROR invoicing ${buyer}: ${err.stack ?? err}`);
      return { failed: "Something went wrong on the server. Please try again." };
    } finally {
      busy.delete(k);
    }
  }

  // All clear buyers (or just `buyer`) -> { sent: [...], skipped: [...], failed: [...] }, in table order.
  // A single buyer that can't be invoiced is refused with a 400/404 error instead.
  async function sendInvoices({ buyer, spend = () => null } = {}) {
    const rows = store.rows();
    const order = buyerGroups(rows).map((group) => key(group.buyer)); // nn = the buyer's place in the table
    let groups = groupByBuyer(rows);
    if (buyer !== undefined) {
      if (!order.includes(key(buyer))) throw refuse(404, `No buyer called ${JSON.stringify(String(buyer))}.`);
      groups = groups.filter((group) => key(group.buyer) === key(buyer));
      if (!groups.length) throw refuse(400, `${buyerGroups(rows)[order.indexOf(key(buyer))].buyer}'s order is cancelled, so it can't be invoiced.`);
      if (!groups[0].invoiceable) throw refuse(400, `${groups[0].buyer} needs a check before invoicing.`);
    }

    const result = { sent: [], skipped: [], failed: [] };
    // One buyer after another (not all at once), to be gentle with PayPal's rate limits.
    for (const group of groups) {
      if (!group.invoiceable) {
        result.skipped.push({ buyer: group.buyer, reason: "Needs a check first." });
        continue;
      }
      const nn = order.indexOf(key(group.buyer)) + 1;
      if (nn > MAX_BUYERS) {
        result.failed.push({ buyer: group.buyer, reason: BATCH_FULL });
        continue;
      }
      const one = await invoiceOne(group.buyer, nn, spend);
      if (one.limited !== undefined) {
        result.limitedMs = one.limited;
        break;
      }
      if (one.sent) result.sent.push(one.sent);
      else if (one.skipped) result.skipped.push({ buyer: group.buyer, reason: one.skipped });
      else result.failed.push({ buyer: group.buyer, reason: one.failed });
    }
    return result;
  }

  return {
    sendInvoices,
    isBusy: () => busy.size > 0,
  };
}
