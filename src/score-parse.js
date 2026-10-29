// Scores the AI's orders against known answers (data/expected-orders.json), field by field, and lists
// EVERY difference in plain words. Pure: no files, no network. Used by scripts/spike-parse.mjs (Step 3b)
// and scripts/accuracy.mjs (Step 8), through src/accuracy.js.
// A cancelled order is scored on its status only: its items, date and flags no longer matter.
import { fromSen, formatMoney } from "./money.js";
import { readPrice } from "./prices.js";

const key = (buyer) => String(buyer ?? "").trim().toLowerCase();
const show = (value) => (value === undefined ? "missing" : JSON.stringify(value));

// The labels printed next to each score (the internal names stay short).
const LABELS = {
  buyers: "buyers", cancellations: "cancellations", items: "items", qty: "quantities", dates: "dates",
  unclear: "unclear flags", fulfilment: "pickup/delivery", prices: "prices",
};

// Plain-English words for the differences. Item ids become the menu's names without the pack size
// ("Classic brownies (box of 6)" -> "Classic brownies"); without a menu the id is shown.
function wordsFor(menu) {
  const names = new Map((menu?.items ?? []).map((i) => [i.id, String(i.name).replace(/\s*\([^)]*\)$/, "")]));
  const name = (id) => (id == null ? "an unclear item" : names.get(id) ?? id);
  const currency = menu?.currency ?? null;
  const money = (sen) => (currency ? formatMoney(fromSen(sen), currency).replace(/\s/g, " ") : (sen / 100).toFixed(2));
  const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    name,
    item: (i) => `${i.qty ?? "?"} x ${name(i.itemId)}`,
    date: (d) => (d == null ? "no date" : /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? `${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d}` : JSON.stringify(d)),
    unclear: (u) => (u ? "needs a check" : "clear"),
    fulfilment: (f) => (f == null ? "not stated" : String(f)),
    price: (p, sen) => `${sen == null ? `${JSON.stringify(p?.text ?? null)} (unreadable)` : money(sen)} for ${p?.itemId == null ? "the whole order" : name(p.itemId)} (message ${p?.msg ?? "?"})`,
  };
}

// An order's real items (empty placeholders like { itemId: null, qty: null } skipped).
const itemsOf = (order) => (Array.isArray(order?.items) ? order.items : []).filter((i) => i && (i.itemId != null || i.qty != null));

// Item ids, or "qty x id", as sorted text, so two orders compare by value.
const idList = (order, withQty) => itemsOf(order).map((i) => (withQty ? `${i.qty ?? "?"} x ${i.itemId ?? "?"}` : `${i.itemId ?? "?"}`)).sort();

// Prices the buyer mentioned (Step 7a). The amount is read the same way the app reads it
// (src/prices.js), so "RM15" and "RM 15" are the same mention.
function prices(order, currency) {
  return (Array.isArray(order?.mentionedPrices) ? order.mentionedPrices : [])
    .map((p) => ({ p, sen: readPrice(p?.text, currency) }))
    .map(({ p, sen }) => ({ p, sen, id: `${p?.itemId ?? "order"} ${sen ?? JSON.stringify(p?.text ?? null)} @${p?.msg ?? "?"}` }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const listText = (list) => (list.length ? list.join(", ") : "none");

// AI orders + expected orders -> { scores: [{ name, label, ok, total }], differences: [string], perfect }.
// Every difference is one plain-English line, e.g. "Jun Wei: expected 2 x Cheese brownies, AI said 1."
// menu gives item names and the currency (needed to read mentioned prices); { currency } alone still works.
export function scoreParse(aiOrders, expectedOrders, { menu = null, currency = menu?.currency ?? null } = {}) {
  const w = wordsFor(menu ?? { currency });
  const differences = [];
  const ai = new Map();
  for (const order of Array.isArray(aiOrders) ? aiOrders : []) {
    const k = key(order?.buyer);
    if (ai.has(k)) differences.push(`${order?.buyer}: the AI returned more than one order for this buyer (only the first is scored).`);
    else ai.set(k, order);
  }

  const counts = {};
  const score = (name, ok) => {
    counts[name] ??= { ok: 0, total: 0 };
    counts[name].total += 1;
    if (ok) counts[name].ok += 1;
  };

  for (const want of expectedOrders) {
    const got = ai.get(key(want.buyer));
    const who = want.buyer;
    score("buyers", Boolean(got));
    if (!got) {
      differences.push(`${who}: expected ${want.status === "cancelled" ? "a cancelled" : "an active"} order, the AI missed this buyer.`);
      continue;
    }
    score("cancellations", got.status === want.status);
    if (got.status !== want.status) differences.push(`${who}: expected ${want.status}, AI said ${got.status ?? "no status"}.`);
    if (want.status === "cancelled") continue; // nothing else matters for a cancelled order

    const sameItems = listText(idList(got, false)) === listText(idList(want, false));
    score("items", sameItems);
    if (!sameItems) differences.push(`${who}: items: expected ${listText(itemsOf(want).map(w.item))}; AI said ${listText(itemsOf(got).map(w.item))}.`);

    const sameQty = listText(idList(got, true)) === listText(idList(want, true));
    score("qty", sameQty);
    if (!sameQty && sameItems) {
      // Same items, other numbers: one line per item, e.g. "expected 2 x Cheese brownies, AI said 1".
      const qtyOf = (order, id) => itemsOf(order).filter((i) => i.itemId === id).map((i) => i.qty ?? "?").join(" + ");
      for (const id of [...new Set(itemsOf(want).map((i) => i.itemId))]) {
        if (qtyOf(got, id) !== qtyOf(want, id)) differences.push(`${who}: expected ${qtyOf(want, id)} x ${w.name(id)}, AI said ${qtyOf(got, id)}.`);
      }
    }

    const fields = [
      ["dates", "date", w.date(got.deliveryDate ?? null), w.date(want.deliveryDate ?? null)],
      ["unclear", "unclear flag", w.unclear(Boolean(got.unclear)), w.unclear(Boolean(want.unclear))],
      ["fulfilment", "pickup/delivery", w.fulfilment(got.fulfilment ?? null), w.fulfilment(want.fulfilment ?? null)],
    ];
    for (const [name, what, gotText, wantText] of fields) {
      score(name, gotText === wantText);
      if (gotText !== wantText) differences.push(`${who}: ${what}: expected ${wantText}, AI said ${gotText}.`);
    }
    const gotPrices = prices(got, currency);
    const wantPrices = prices(want, currency);
    const samePrices = listText(gotPrices.map((x) => x.id)) === listText(wantPrices.map((x) => x.id));
    score("prices", samePrices);
    if (!samePrices) {
      const text = (list) => listText(list.map(({ p, sen }) => w.price(p, sen)));
      differences.push(`${who}: prices: expected ${text(wantPrices)}, AI said ${text(gotPrices)}.`);
    }
  }

  const expectedKeys = new Set(expectedOrders.map((o) => key(o.buyer)));
  for (const [k, order] of ai) {
    if (!expectedKeys.has(k)) differences.push(`${order?.buyer}: the AI added an order the expected answers don't have (${order?.status}: ${listText(itemsOf(order).map(w.item))}).`);
  }

  const order = ["buyers", "cancellations", "items", "qty", "dates", "unclear", "fulfilment", "prices"];
  const scores = order.filter((name) => counts[name]).map((name) => ({ name, label: LABELS[name], ...counts[name] }));
  return { scores, differences, perfect: differences.length === 0 };
}

// The checks our code will run on every AI order (PLAN.md Section 5), as a report: message numbers
// must exist, and the date must be real and on or up to 14 days after the order's latest message.
// (Item ids and quantities are checked by toRows() in src/orders.js.) Step 4 builds these into the app.
export function structureChecks(aiOrders, messages) {
  const problems = [];
  const dateOf = new Map(messages.map((m) => [m.n, m.date]));
  const days = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  for (const order of Array.isArray(aiOrders) ? aiOrders : []) {
    const name = order?.buyer || "(no name)";
    const msgs = Array.isArray(order?.sourceMsgs) ? order.sourceMsgs : [];
    const unknown = msgs.filter((n) => !dateOf.has(n));
    if (!msgs.length) problems.push(`${name}: no source messages.`);
    if (unknown.length) problems.push(`${name}: message number(s) ${unknown.join(", ")} don't exist.`);
    if (order?.deliveryDate != null) {
      const real = /^\d{4}-\d{2}-\d{2}$/.test(order.deliveryDate) && new Date(`${order.deliveryDate}T00:00:00Z`).toISOString().slice(0, 10) === order.deliveryDate;
      const latest = msgs.map((n) => dateOf.get(n)).filter(Boolean).sort().at(-1);
      if (!real) problems.push(`${name}: date ${show(order.deliveryDate)} is not a real date.`);
      else if (latest) {
        const gap = days(order.deliveryDate) - days(latest);
        if (gap < 0 || gap > 14) problems.push(`${name}: date ${order.deliveryDate} is ${gap} days from its latest message (${latest}); allowed 0-14.`);
      }
    }
    if (typeof order?.note === "string" && order.note.length > 120) problems.push(`${name}: note is ${order.note.length} characters (max 120).`);
  }
  return problems;
}
