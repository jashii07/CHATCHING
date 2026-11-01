// The kitchen list (Step 10b): per date, how many of each item to make. Pure code, no AI: it's counting.
// Counts active, clear orders (invoiced, paid or not yet: the seller still has to make them).
// Left out: cancelled orders, and buyers whose PayPal invoice was cancelled or refunded.
// An order that needs a check is not counted, but shown under its date as "+1 order still to check".
import { cancelledAtPayPal, groupByBuyer } from "./orders.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NO_DATE = "No date yet";

// "2026-10-31" -> "Sat 31 Oct". UTC, so a time zone can't shift the day.
function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const toCheckText = (count) => `+${count} ${count === 1 ? "order" : "orders"} still to check`;

// rows (from the store) -> { days: [{ date, label, items: [{ itemId, name, qty }], toCheck }], text }.
// Days are earliest first, "No date yet" last; items follow the menu's order. text is what Copy copies.
export function kitchenList(rows, menu) {
  const days = new Map(); // date (or null) -> { qty per itemId, buyers to check }
  const day = (date) => {
    if (!days.has(date)) days.set(date, { qty: new Map(), toCheck: new Set() });
    return days.get(date);
  };
  groupByBuyer(rows).forEach((group, i) => {
    if (cancelledAtPayPal(group)) return;
    for (const row of group.rows) {
      const entry = day(row.deliveryDate ?? null);
      // One order = one buyer: if any of their rows needs a check, none of them is counted yet.
      if (!group.invoiceable) entry.toCheck.add(i);
      else entry.qty.set(row.itemId, (entry.qty.get(row.itemId) ?? 0) + row.qty);
    }
  });

  // ISO dates sort as text; null ("No date yet") goes last.
  const dates = [...days.keys()].sort((a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b)));
  const list = dates.map((date) => {
    const { qty, toCheck } = days.get(date);
    const items = menu.items.filter((item) => qty.has(item.id)).map((item) => ({ itemId: item.id, name: item.name, qty: qty.get(item.id) }));
    return { date, label: date ? dayLabel(date) : NO_DATE, items, toCheck: toCheck.size };
  });

  const lines = list.map((entry) => [
    entry.label,
    ...entry.items.map((item) => `${item.qty} x ${item.name}`),
    ...(entry.toCheck ? [toCheckText(entry.toCheck)] : []),
  ].join("\n"));
  return { days: list, text: ["Kitchen list", ...(lines.length ? lines : ["Nothing to make yet."])].join("\n\n") };
}
