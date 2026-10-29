// Price mismatch (Step 7a, PLAN.md Section 5 "mentionedPrices"). The AI only REPORTS prices a buyer
// wrote ("is it RM15?"); this code reads the number and compares it with the menu. A match is the unit
// price, the line total or the whole order total. Anything else, or a price we can't read, becomes a
// reason that makes the row unclear: check first, charge second. The invoice price always comes from the
// menu: nothing here changes a price. Pure: no files, no network, no clock.
import { toSen, fromSen, formatMoney } from "./money.js";

// The ways a buyer may write the menu's currency: its code ("MYR") and its symbol, taken from Intl
// (the same narrowSymbol money.js shows), so no currency is hard-coded here.
function currencyWords(currency) {
  const symbol = new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
    .formatToParts(0).find((part) => part.type === "currency")?.value;
  return [currency, symbol].filter(Boolean).map((word) => word.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&"));
}

// "RM15", "rm 15.50", "15 MYR", "2 for RM36" -> the amount in sen; null if it can't be read for sure.
// A number next to the currency wins; otherwise the text must hold exactly one number.
export function readPrice(text, currency) {
  if (typeof text !== "string") return null;
  const clean = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const amount = "(\\d+(?:\\.\\d{1,2})?)(?![\\d.])";
  const words = currencyWords(currency).join("|");
  const near = clean.match(new RegExp(`(?:${words})\\s*${amount}`, "i")) ?? clean.match(new RegExp(`${amount}\\s*(?:${words})`, "i"));
  if (near) return toSen(near[1]);
  const numbers = clean.match(/\d+(?:\.\d{1,2})?(?![\d.])/g) ?? [];
  return numbers.length === 1 ? toSen(numbers[0]) : null;
}

const senOf = (amount) => (amount == null ? null : toSen(amount));

// One order's mentions + its rows (already priced from the menu) -> Map(row index -> priceCheck), where
// priceCheck = { reason, msgs, kept: false }. Mentions that match make no entry.
export function checkMentionedPrices(mentions, rows, menu) {
  const checks = new Map();
  if (!Array.isArray(mentions) || !rows.length) return checks;
  const money = (sen) => formatMoney(fromSen(sen), menu.currency);
  const lines = rows.map((row) => senOf(row.lineTotal));
  const orderTotal = lines.every((sen) => sen != null) ? lines.reduce((a, b) => a + b, 0) : null;

  for (const mention of mentions) {
    const text = typeof mention?.text === "string" ? mention.text.trim() : "";
    const item = menu.items.find((it) => it.id === mention?.itemId) ?? null;
    // Which rows the mention is about: that item's rows, or the whole order when no (known) item is named.
    const about = item ? rows.map((row, i) => (row.itemId === item.id ? i : -1)).filter((i) => i >= 0) : rows.map((_, i) => i);
    const target = about[0] ?? 0;
    const candidates = [
      ...(item ? [toSen(item.price)] : rows.map((row) => senOf(row.unitPrice))),
      ...about.map((i) => lines[i]),
      orderTotal,
    ].filter((sen) => sen != null);

    const said = readPrice(text, menu.currency);
    let reason = "";
    if (said == null) reason = `buyer mentioned ${JSON.stringify(text || String(mention?.text ?? ""))}, which the app can't read as a price.`;
    else if (!candidates.length) reason = `buyer mentioned ${money(said)}, but this order has no menu price to compare.`;
    else if (!candidates.includes(said)) {
      const nearest = candidates.reduce((best, sen) => (Math.abs(sen - said) < Math.abs(best - said) ? sen : best));
      reason = `buyer mentioned ${money(said)}, menu says ${money(nearest)}.`;
    }
    if (!reason) continue;
    const check = checks.get(target) ?? { reason: "", msgs: [], kept: false };
    check.reason = [check.reason, reason].filter(Boolean).join(" ");
    if (Number.isInteger(mention?.msg) && !check.msgs.includes(mention.msg)) check.msgs.push(mention.msg);
    checks.set(target, check);
  }
  return checks;
}
