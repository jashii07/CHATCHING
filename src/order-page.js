// What the buyer's "Your order" page shows (6 Nov), and the buyer's answer. Pure: no files, no network, no clock.
// The page shows ONLY this buyer: their items, the total from the menu, the day, pickup or delivery, their own
// messages (marked as in the seller's drawer), the PayPal Pay link while unpaid, and the status. Never the
// seller's visitor id, the batch, another buyer, or the AI's note (that is the seller's working note, and it
// can name other buyers, e.g. "same as Lina"). The money words are built here, so the page does no maths.
// The buyer can only say "Looks right" or "Something's wrong" with a short note. A note is untrusted text: it
// is tidied here and every page shows it with textContent, never as HTML. It never changes an item, a
// quantity or a price: the seller reads it and decides.
import { toSen, fromSen, formatMoney } from "./money.js";
import { dayLabel } from "./messages.js";
import { buyerPanel } from "./panel.js";

export const NOTE_MAX = 200;
export const NOTE_TOO_LONG = `Please keep the note to ${NOTE_MAX} characters.`;
export const BAD_ANSWER = 'Send { "token": "...", "answer": "ok" } or { "token": "...", "answer": "wrong", "note": "..." }.';
const ANSWERS = new Set(["ok", "wrong"]);
// Hidden characters that could make a note look different from what it says: control characters, and the
// marks that flip text direction or hide in it (zero-width ones). Emoji joiners stay, so emoji keep their look.
const HIDDEN = /[\p{Cc}؜​‎‏‪-‮⁠⁦-⁩﻿]/gu;

// The buyer's answer -> { answer: { answer, note } } or { error }. Only these fields; anything else is refused,
// so a buyer can never send an item, a quantity or a price.
export function readAnswer(body) {
  const { token, answer, note, ...rest } = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (Object.keys(rest).length || !ANSWERS.has(answer)) return { error: BAD_ANSWER };
  if (note !== undefined && (typeof note !== "string" || answer !== "wrong")) return { error: BAD_ANSWER };
  if (typeof note === "string" && note.length > NOTE_MAX * 8) return { error: NOTE_TOO_LONG }; // before any work
  const clean = String(note ?? "").replace(/\s+/gu, " ").replace(HIDDEN, "").replace(/ {2,}/g, " ").trim();
  if ([...clean].length > NOTE_MAX) return { error: NOTE_TOO_LONG }; // characters as people count them: an emoji is one
  return { answer: { answer, note: clean } };
}

const isPaid = (status) => String(status).startsWith("Paid"); // Paid, or Paid (cash/bank)

function stateOf(rows) {
  const status = rows[0].invoiceStatus;
  if (isPaid(status) && rows.every((row) => row.collected === true)) return ["collected", "Collected"];
  if (isPaid(status)) return ["paid", "Paid"];
  if (status === "Part paid") return ["part-paid", "Part paid"];
  if (status === "Cancelled/Refunded") return ["cancelled", "Cancelled"];
  return ["unpaid", "Not paid"];
}

// One buyer's invoice rows (active, sent) + the chats + the menu -> the page's data.
// qr: { png } or { notice } once paid (the route asks PayPal), else null. checkFailed: PayPal couldn't be asked.
export function orderView(rows, source, menu, { qr = null, checkFailed = false } = {}) {
  const money = (amount) => formatMoney(amount, menu.currency);
  const [status, statusLabel] = stateOf(rows);
  const total = fromSen(rows.reduce((sum, row) => sum + toSen(row.lineTotal), 0));
  const fulfilment = rows.find((row) => row.fulfilment)?.fulfilment ?? null;
  const answer = rows.find((row) => row.buyerAnswer)?.buyerAnswer ?? null;
  const messages = buyerPanel(rows, source, menu).messages
    .filter((msg) => msg.own && msg.used)
    .map(({ when, parts }) => ({ when, parts }));
  return {
    buyer: rows[0].buyer,
    items: rows.map((row) => ({ qty: row.qty, name: menu.items.find((item) => item.id === row.itemId)?.name ?? row.itemName, lineTotal: money(row.lineTotal) })),
    total: money(total),
    dates: [...new Set(rows.map((row) => row.deliveryDate).filter(Boolean))].sort().map(dayLabel),
    fulfilment: fulfilment === "pickup" ? "Pickup" : fulfilment === "delivery" ? "Delivery" : null,
    messages,
    status,
    statusLabel,
    payLink: status === "unpaid" || status === "part-paid" ? rows[0].payerLink : null, // nobody is asked to pay twice
    answer: answer && { answer: answer.answer, note: answer.note ?? "" },
    qr: status === "paid" ? qr : null, // the pickup QR once paid; after Collected there is nothing to show
    checkFailed,
  };
}
