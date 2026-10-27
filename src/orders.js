// Pure order logic: no files, no network, no clock. The menu is passed in.
// The AI never sets prices: every price comes from the menu, and money is in sen (money.js).
// Anything that fails a check becomes an unclear row with a reason. Nothing is dropped silently.
import { toSen, fromSen } from "./money.js";

// Currency codes the computer knows, and PayPal's currencies that take no decimals (PayPal docs, "Currency codes").
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const NO_DECIMALS = ["HUF", "JPY", "TWD"];

const findItem = (menu, itemId) => menu.items.find((item) => item.id === itemId);
const cleanName = (buyer) => (typeof buyer === "string" ? buyer.trim() : "");
// "Mak's Choc-Chip!" -> "mak s choc chip": lowercase words only. Used for chat text AND aliases.
const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Problems in menu.json, as plain sentences ([] = all good). The server checks this once at start,
// so a bad price stops the server with a clear message instead of crashing on the first order.
export function checkMenu(menu) {
  if (!Array.isArray(menu?.items)) return ["The menu has no items list."];
  const problems = [];
  if (!CURRENCIES.has(menu.currency)) {
    problems.push(`Bad currency ${JSON.stringify(menu.currency)}: use a 3-letter code like "MYR" or "USD".`);
  } else if (NO_DECIMALS.includes(menu.currency)) {
    problems.push(`PayPal bills ${menu.currency} without decimals, but menu prices use cents ("18.00"). Use another currency.`);
  }
  const seen = new Set();
  menu.items.forEach((item, i) => {
    const label = item?.id ? `"${item.id}"` : `item ${i + 1}`;
    if (typeof item?.id !== "string" || !item.id) problems.push(`${label} has no id.`);
    else if (seen.has(item.id)) problems.push(`${label} is used more than once.`);
    else seen.add(item.id);
    if (typeof item?.name !== "string" || !item.name.trim()) problems.push(`${label} has no name.`);
    if (!/^\d+(\.\d{1,2})?$/.test(typeof item?.price === "string" ? item.price : "")) {
      problems.push(`${label} has a bad price ${JSON.stringify(item?.price)}: use text like "18.00".`);
    }
    if (!Array.isArray(item?.aliases)) problems.push(`${label} needs an aliases list.`);
  });
  return problems;
}

// The checks for one item + qty. Returns the menu facts and the reasons it is unclear (if any).
function checkItem(itemId, qty, menu) {
  const reasons = [];
  const item = findItem(menu, itemId);
  if (itemId == null || itemId === "") reasons.push("No menu item chosen.");
  else if (!item) reasons.push(`Unknown item "${itemId}".`);

  const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= 99;
  if (qty == null) reasons.push("Quantity missing.");
  else if (!qtyOk) {
    const shown = typeof qty === "number" ? String(qty) : JSON.stringify(qty); // NaN stays "NaN", not "null"
    reasons.push(`Quantity must be a whole number from 1 to 99 (got ${shown}).`);
  }

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
    const buyer = cleanName(order?.buyer);
    const orderStatus = order?.status === "cancelled" ? "cancelled" : "active";
    const orderReasons = [];
    if (order?.unclear) {
      const aiReason = typeof order.reason === "string" && order.reason.trim();
      orderReasons.push(aiReason || "The AI marked this order unclear.");
    }
    if (!buyer) orderReasons.push("Buyer name missing.");

    // An order with no items still gets one row, so the seller sees it.
    // A null or broken entry inside items becomes an empty (unclear) row instead of a crash.
    const items = Array.isArray(order?.items) && order.items.length ? order.items : [null];
    for (const entry of items) {
      const { itemId = null, qty = null } = entry && typeof entry === "object" ? entry : {};
      const check = checkItem(itemId, qty, menu);
      const reasons = orderStatus === "active" ? [...orderReasons, ...check.reasons] : [];
      rows.push({
        id: `r${rows.length + 1}`, buyer, buyerEmail: null, orderStatus,
        itemId, itemName: check.itemName, qty,
        unitPrice: check.unitPrice, lineTotal: check.lineTotal,
        deliveryDate: order?.deliveryDate ?? null, fulfilment: order?.fulfilment ?? null,
        unclear: reasons.length > 0, reason: reasons.join(" "),
        note: typeof order?.note === "string" ? order.note : "", sourceMsgs: order?.sourceMsgs ?? [],
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
  if (!cleanName(row.buyer)) check.reasons.unshift("Buyer name missing.");
  const reasons = row.orderStatus === "active" ? check.reasons : [];
  return {
    ...row,
    itemName: check.itemName, unitPrice: check.unitPrice, lineTotal: check.lineTotal,
    unclear: reasons.length > 0, reason: reasons.join(" "),
  };
}

// The fields the seller can edit in the table, and the checks for each.
const EDITS = {
  itemId: (value, menu) => (findItem(menu, value) ? "" : `Unknown menu item ${JSON.stringify(value)}.`),
  qty: (value) => (Number.isInteger(value) && value >= 1 && value <= 99 ? "" : `Quantity must be a whole number from 1 to 99 (got ${JSON.stringify(value)}).`),
  deliveryDate: (value) => {
    if (value === null) return "";
    const m = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
    const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d && d.toISOString().slice(0, 10) === value ? "" : `Not a real date ${JSON.stringify(value)}: use YYYY-MM-DD.`;
  },
};

// A seller's edit (the PUT body) -> { changes, problems }. Unlike AI output, a bad edit is refused,
// not turned into an unclear row: the seller gets the reason and the row stays as it was.
export function checkEdit(edit, menu) {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
    return { changes: {}, problems: ["Send the changes as a JSON object, e.g. { \"qty\": 2 }."] };
  }
  const problems = [];
  const fields = Object.keys(edit);
  if (!fields.length) problems.push(`Nothing to change: send one of ${Object.keys(EDITS).join(", ")}.`);
  for (const field of fields) {
    if (!Object.hasOwn(EDITS, field)) problems.push(`"${field}" can't be edited: use ${Object.keys(EDITS).join(", ")}.`);
    else {
      const problem = EDITS[field](edit[field], menu);
      if (problem) problems.push(problem);
    }
  }
  return { changes: problems.length ? {} : { ...edit }, problems };
}

// One invoice group per buyer, in table order. Cancelled rows are skipped.
// "Lina", "lina" and " Lina " are one buyer (one invoice), shown with the first spelling.
// A buyer is invoiceable only when ALL their active rows are clear; total is null otherwise.
export function groupByBuyer(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.orderStatus !== "active") continue;
    const key = cleanName(row.buyer).toLowerCase();
    if (!groups.has(key)) groups.set(key, { buyer: row.buyer, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map((group) => {
    const invoiceable = group.rows.every((row) => !row.unclear);
    const sen = group.rows.reduce((sum, row) => sum + (row.lineTotal ? toSen(row.lineTotal) : 0), 0);
    return { ...group, invoiceable, total: invoiceable ? fromSen(sen) : null };
  });
}

// For the pinned totals row: how many orders can be invoiced, and their total.
export function totals(rows) {
  const ready = groupByBuyer(rows).filter((group) => group.invoiceable);
  return { orders: ready.length, total: fromSen(ready.reduce((sum, group) => sum + toSen(group.total), 0)) };
}

// The table's buyer groups, in first-seen order: every row of one buyer (cancelled ones too) sits
// together under one name. items + total come from groupByBuyer (active rows only); total is null
// while the buyer needs a check, and a buyer with only cancelled rows is marked cancelled.
export function buyerGroups(rows) {
  const key = (buyer) => cleanName(buyer).toLowerCase();
  const invoice = new Map(groupByBuyer(rows).map((group) => [key(group.buyer), group]));
  const groups = new Map();
  for (const row of rows) {
    const k = key(row.buyer);
    if (!groups.has(k)) groups.set(k, { buyer: row.buyer, rowIds: [] });
    groups.get(k).rowIds.push(row.id);
  }
  return [...groups].map(([k, group]) => {
    const active = invoice.get(k);
    return { ...group, items: active?.rows.length ?? 0, total: active?.total ?? null, cancelled: !active };
  });
}

// The four summary cards at the top of the page, counted per buyer (one buyer = one order):
// orders = active buyers; ready + expected = what can be invoiced now (same as totals);
// paid = buyers whose rows are all Paid or Paid (cash/bank); needsCheck = buyers with an unclear row.
export function summary(rows) {
  const groups = groupByBuyer(rows);
  const ready = totals(rows);
  const paidGroups = groups.filter((group) => group.invoiceable && group.rows.every((row) => String(row.invoiceStatus).startsWith("Paid")));
  return {
    orders: groups.length,
    ready: ready.orders,
    expected: ready.total,
    paidOrders: paidGroups.length,
    paid: fromSen(paidGroups.reduce((sum, group) => sum + toSen(group.total), 0)),
    needsCheck: groups.filter((group) => !group.invoiceable).length,
  };
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
  return Object.hasOwn(PAYPAL_STATUS, status) ? PAYPAL_STATUS[status] : String(status);
}

// Free text ("2 kotak brownies classic") -> one menu item, using the menu aliases.
// Longest aliases are matched first and then blanked out, so "cheese brownies" is used up
// before the ambiguous word "brownies" is checked. Whole words only; text and aliases are
// cleaned the same way, so "choc-chip" in the menu matches "choc-chip" in a chat.
export function matchMenuItem(text, menu) {
  const unclear = (reason) => ({ itemId: null, unclear: true, reason });
  let words = ` ${cleanWords(text)} `;
  if (!words.trim()) return unclear("No item text.");

  const aliases = menu.items
    .flatMap((item) => item.aliases.map((alias) => ({ id: item.id, alias: cleanWords(alias) })))
    .filter(({ alias }) => alias)
    .sort((a, b) => b.alias.length - a.alias.length);
  const found = new Set();
  for (const { id, alias } of aliases) {
    // One at a time, leaving one space behind, so back-to-back repeats ("x y x y") are all used up.
    while (words.includes(` ${alias} `)) {
      found.add(id);
      words = words.replace(` ${alias} `, " ");
    }
  }

  if (found.size === 1) return { itemId: [...found][0], unclear: false, reason: "" };
  if (found.size > 1) {
    const names = [...found].map((id) => findItem(menu, id).name).join(", ");
    return unclear(`More than one menu item: ${names}.`);
  }
  const ambiguous = (menu.ambiguous ?? []).find((a) => a.words.some((w) => words.includes(` ${cleanWords(w)} `)));
  return unclear(ambiguous ? ambiguous.reason : `No menu item found in "${String(text).trim()}".`);
}
