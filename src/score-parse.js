// Scores the AI's orders against known answers (data/expected-orders.json), field by field, and lists
// EVERY difference in plain words. Pure: no files, no network. Used by scripts/spike-parse.mjs (Step 3b)
// and, later, scripts/accuracy.mjs (Step 8).
// A cancelled order is scored on its status only: its items, date and flags no longer matter.

const key = (buyer) => String(buyer ?? "").trim().toLowerCase();
const show = (value) => (value === undefined ? "missing" : JSON.stringify(value));

// Items as comparable text, ignoring empty placeholders ({ itemId: null, qty: null }).
function itemList(order, withQty) {
  return (Array.isArray(order?.items) ? order.items : [])
    .filter((i) => i && (i.itemId != null || i.qty != null))
    .map((i) => (withQty ? `${i.qty ?? "?"} × ${i.itemId ?? "?"}` : `${i.itemId ?? "?"}`))
    .sort();
}

const listText = (list) => (list.length ? list.join(", ") : "none");

// AI orders + expected orders -> { scores: [{ name, ok, total }], differences: [string], perfect }.
export function scoreParse(aiOrders, expectedOrders) {
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
    score("buyers", Boolean(got));
    if (!got) {
      differences.push(`${want.buyer}: missing from the AI reply (expected ${want.status}).`);
      continue;
    }
    score("cancellations", got.status === want.status);
    if (got.status !== want.status) differences.push(`${want.buyer}: status ${show(got.status)}, expected ${show(want.status)}.`);
    if (want.status === "cancelled") continue; // nothing else matters for a cancelled order

    const fields = [
      ["items", listText(itemList(got, false)), listText(itemList(want, false))],
      ["qty", listText(itemList(got, true)), listText(itemList(want, true))],
      ["dates", show(got.deliveryDate ?? null), show(want.deliveryDate)],
      ["unclear", show(Boolean(got.unclear)), show(want.unclear)],
      ["fulfilment", show(got.fulfilment ?? null), show(want.fulfilment)],
    ];
    for (const [name, gotText, wantText] of fields) {
      score(name, gotText === wantText);
      if (gotText !== wantText) differences.push(`${want.buyer}: ${name} ${gotText}, expected ${wantText}.`);
    }
  }

  const expectedKeys = new Set(expectedOrders.map((o) => key(o.buyer)));
  for (const [k, order] of ai) {
    if (!expectedKeys.has(k)) differences.push(`${order?.buyer}: an extra order the answers don't have (${order?.status}, items ${listText(itemList(order, true))}).`);
  }

  const order = ["buyers", "cancellations", "items", "qty", "dates", "unclear", "fulfilment"];
  const scores = order.filter((name) => counts[name]).map((name) => ({ name, ...counts[name] }));
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
