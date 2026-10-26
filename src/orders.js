// Pure order logic: no files, no network, no clock. The menu is passed in.
// The AI never sets prices: every price comes from the menu, and money is in sen (money.js).
// Anything that fails a check becomes an unclear row with a reason. Nothing is dropped silently.
import { toSen, fromSen } from "./money.js";

const findItem = (menu, itemId) => menu.items.find((item) => item.id === itemId);

// The checks for one item + qty. Returns the menu facts and the reasons it is unclear (if any).
function checkItem(itemId, qty, menu) {
  const reasons = [];
  const item = findItem(menu, itemId);
  if (itemId == null || itemId === "") reasons.push("No menu item chosen.");
  else if (!item) reasons.push(`Unknown item "${itemId}".`);

  const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= 99;
  if (qty == null) reasons.push("Quantity missing.");
  else if (!qtyOk) reasons.push(`Quantity must be a whole number from 1 to 99 (got ${JSON.stringify(qty)}).`);

  return {
    itemName: item?.name ?? null,
    unitPrice: item?.price ?? null,
    lineTotal: item && qtyOk ? fromSen(toSen(item.price) * qty) : null,
    reasons,
  };
}

// AI orders (the final order per buyer, PLAN.md Section 5) -> table rows, one row per item.
// Cancelled orders stay as rows (greyed out in the table); they are never "unclear",
// because only active rows need fixing.
export function toRows(aiOrders, menu) {
  if (!Array.isArray(aiOrders)) throw new TypeError("aiOrders must be an array");
  const rows = [];
  for (const order of aiOrders) {
    const buyer = typeof order?.buyer === "string" ? order.buyer.trim() : "";
    const orderStatus = order?.status === "cancelled" ? "cancelled" : "active";
    const orderReasons = [];
    if (order?.unclear) orderReasons.push(order.reason || "The AI marked this order unclear.");
    if (!buyer) orderReasons.push("Buyer name missing.");

    // An order with no items still gets one row, so the seller sees it.
    const items = Array.isArray(order?.items) && order.items.length ? order.items : [{ itemId: null, qty: null }];
    for (const { itemId = null, qty = null } of items) {
      const check = checkItem(itemId, qty, menu);
      const reasons = orderStatus === "active" ? [...orderReasons, ...check.reasons] : [];
      rows.push({
        id: `r${rows.length + 1}`, buyer, buyerEmail: null, orderStatus,
        itemId, itemName: check.itemName, qty,
        unitPrice: check.unitPrice, lineTotal: check.lineTotal,
        deliveryDate: order?.deliveryDate ?? null, fulfilment: order?.fulfilment ?? null,
        unclear: reasons.length > 0, reason: reasons.join(" "),
        note: order?.note ?? "", sourceMsgs: order?.sourceMsgs ?? [],
        invoiceId: null, invoiceNumber: null, payerLink: null, invoiceStatus: "Draft",
      });
    }
  }
  return rows;
}

// After the seller edits the item or qty: a new row with the name, price, total and unclear flag updated.
// The edit counts as the seller's fix, so the AI's own "unclear" flag is dropped; only our checks remain.
export function recalcRow(row, menu) {
  const check = checkItem(row.itemId, row.qty, menu);
  if (!row.buyer) check.reasons.unshift("Buyer name missing.");
  const reasons = row.orderStatus === "active" ? check.reasons : [];
  return {
    ...row,
    itemName: check.itemName, unitPrice: check.unitPrice, lineTotal: check.lineTotal,
    unclear: reasons.length > 0, reason: reasons.join(" "),
  };
}

// One invoice group per buyer, in table order. Cancelled rows are skipped.
// A buyer is invoiceable only when ALL their active rows are clear; total is null otherwise.
export function groupByBuyer(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.orderStatus !== "active") continue;
    if (!groups.has(row.buyer)) groups.set(row.buyer, { buyer: row.buyer, rows: [] });
    groups.get(row.buyer).rows.push(row);
  }
  return [...groups.values()].map((group) => {
    const invoiceable = group.rows.every((row) => !row.unclear);
    const sen = group.rows.reduce((sum, row) => sum + (row.lineTotal ? toSen(row.lineTotal) : 0), 0);
    return { ...group, invoiceable, total: invoiceable ? fromSen(sen) : null };
  });
}

// For the pinned totals row: how many orders can be invoiced, and their RM total.
export function totals(rows) {
  const ready = groupByBuyer(rows).filter((group) => group.invoiceable);
  return { orders: ready.length, total: fromSen(ready.reduce((sum, group) => sum + toSen(group.total), 0)) };
}

// PayPal invoice status -> what the app shows (PLAN.md Section 5).
const PAYPAL_STATUS = {
  DRAFT: "Draft",
  SENT: "Sent", UNPAID: "Sent", SCHEDULED: "Sent", PAYMENT_PENDING: "Sent",
  PARTIALLY_PAID: "Part paid",
  PAID: "Paid",
  MARKED_AS_PAID: "Paid (cash/bank)",
  CANCELLED: "Cancelled/Refunded", REFUNDED: "Cancelled/Refunded",
  PARTIALLY_REFUNDED: "Cancelled/Refunded", MARKED_AS_REFUNDED: "Cancelled/Refunded",
};

// No invoice yet -> "Draft". A status PayPal adds later is shown as-is, never hidden.
export function mapPayPalStatus(status) {
  if (status == null) return "Draft";
  return PAYPAL_STATUS[status] ?? status;
}

// Free text ("2 kotak brownies classic") -> one menu item, using the menu aliases.
// Longest aliases are matched first and then blanked out, so "cheese brownies" is used up
// before the ambiguous word "brownies" is checked. Whole words only.
export function matchMenuItem(text, menu) {
  const unclear = (reason) => ({ itemId: null, unclear: true, reason });
  let words = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (!words.trim()) return unclear("No item text.");

  const aliases = menu.items
    .flatMap((item) => item.aliases.map((alias) => ({ id: item.id, alias: alias.toLowerCase() })))
    .sort((a, b) => b.alias.length - a.alias.length);
  const found = new Set();
  for (const { id, alias } of aliases) {
    if (words.includes(` ${alias} `)) {
      found.add(id);
      words = words.replaceAll(` ${alias} `, "  ");
    }
  }

  if (found.size === 1) return { itemId: [...found][0], unclear: false, reason: "" };
  if (found.size > 1) {
    const names = [...found].map((id) => findItem(menu, id).name).join(", ");
    return unclear(`More than one menu item: ${names}.`);
  }
  const ambiguous = (menu.ambiguous ?? []).find((a) => a.words.some((w) => words.includes(` ${w.toLowerCase()} `)));
  return unclear(ambiguous ? ambiguous.reason : `No menu item found in "${String(text).trim()}".`);
}
