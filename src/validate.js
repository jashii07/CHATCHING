// Our checks on the AI's orders, against the messages that were pasted (PLAN.md Section 5), before
// toRows() turns them into rows. Pure: no files, no network, no clock.
// A problem never drops an order: the order becomes unclear, with every problem in its reason.
// (toRows() then checks the items and quantities against the menu.)
// The one exception (1 Nov): an "order" that is really the seller's own reply is not an order at all. It is
// removed, so it never creates a buyer (sellerOrders names what was removed).
import { isSeller, isSellerMessage, sameName, senderOf } from "./seller.js";

export const MAX_NOTE = 120;
const MAX_DAYS_AHEAD = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = ["active", "cancelled"];
const FULFILMENTS = ["delivery", "pickup", null, undefined]; // missing = the buyer didn't say
const NOT_THEIR_MESSAGES = "this order doesn't match who wrote the messages.";
const NOT_THEIR_CANCEL = "only the buyer or the seller can cancel this order, and another buyer's message was used.";

// "2026-10-28" -> day number, or null if it isn't a real date.
function dayOf(iso) {
  const m = typeof iso === "string" ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === iso ? d.getTime() / DAY_MS : null;
}

const label = (days) => new Date(days * DAY_MS).toLocaleDateString("en-GB", {
  weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
}).replace(/,/g, "");

// True when every message the order cites was written by the seller.
function onlyFromSeller(order, messages, menu) {
  const own = (Array.isArray(order?.sourceMsgs) ? order.sourceMsgs : []).map((n) => messages[n - 1]).filter(Boolean);
  return own.length > 0 && own.every((msg) => isSellerMessage(msg, menu));
}

// The AI's orders that are really the seller talking: in the seller's name, or built only from the seller's
// messages for someone who wrote nothing in this chat.
export function sellerOrders(aiOrders, messages, menu) {
  return aiOrders.filter((order) => order && typeof order === "object" && (isSeller(order.buyer, menu)
    || (onlyFromSeller(order, messages, menu) && !messages.some((msg) => sameName(senderOf(msg.text), order.buyer)))));
}

// A chat message must never create or cancel someone else's order. Only messages with a readable sender can be
// judged: a pasted message with no "Name:" could be anyone's. -> a problem (plain words), or "".
function wrongAuthor(order, own, menu) {
  if (typeof order.buyer !== "string" || !order.buyer.trim() || !own.length) return "";
  if (own.every((msg) => isSellerMessage(msg, menu))) return ""; // problemsOf already says it came from the seller
  const senders = own.map((msg) => senderOf(msg.text));
  if (senders.every(Boolean) && !senders.some((sender) => sameName(sender, order.buyer))) return NOT_THEIR_MESSAGES;
  const someoneElse = (sender) => sender && !sameName(sender, order.buyer) && !isSeller(sender, menu);
  return order.status === "cancelled" && senders.some(someoneElse) ? NOT_THEIR_CANCEL : "";
}

// One order -> the list of problems (plain sentences) + its message numbers that really exist.
function problemsOf(order, messages, menu) {
  const problems = [];
  let badDate = false;
  const asked = Array.isArray(order.sourceMsgs) ? order.sourceMsgs : [];
  const real = [...new Set(asked.filter((n) => Number.isInteger(n) && n >= 1 && n <= messages.length))];
  const missing = asked.filter((n) => !real.includes(n));

  if (!STATUSES.includes(order.status)) problems.push(`Unknown order status ${JSON.stringify(order.status)}.`);
  if (!real.length && !missing.length) problems.push("The AI didn't say which messages this order came from.");
  if (missing.length) {
    problems.push(`Message ${missing.map(String).join(", ")} is not in the chat (it has ${messages.length} messages).`);
  }

  // The order's own messages: an impossible timestamp or a date far from the Chat date shows here.
  const own = real.map((n) => messages[n - 1]);
  for (const msg of own) {
    if (msg.reason) problems.push(`Message ${msg.n}: ${msg.reason}`);
    else if (msg.warning) problems.push(`Message ${msg.n} is dated ${msg.label}: ${msg.warning}.`);
  }

  if (order.deliveryDate != null) {
    const day = dayOf(order.deliveryDate);
    const dated = own.filter((msg) => msg.date).map((msg) => ({ n: msg.n, day: dayOf(msg.date) }));
    if (day === null) {
      problems.push(`The delivery date ${JSON.stringify(order.deliveryDate)} is not a real date.`);
      badDate = true;
    }
    else if (dated.length) {
      const first = dated.reduce((a, b) => (b.day < a.day ? b : a));
      const last = dated.reduce((a, b) => (b.day > a.day ? b : a));
      if (day < first.day) problems.push(`The delivery date ${label(day)} is before message ${first.n} (${label(first.day)}).`);
      else if (day > last.day + MAX_DAYS_AHEAD) {
        problems.push(`The delivery date ${label(day)} is more than ${MAX_DAYS_AHEAD} days after message ${last.n}.`);
      }
    }
  }

  if (!FULFILMENTS.includes(order.fulfilment)) problems.push(`Unknown pickup or delivery ${JSON.stringify(order.fulfilment)}.`);
  if (onlyFromSeller(order, messages, menu)) problems.push("This order came only from the seller's messages.");
  const author = wrongAuthor(order, own, menu);
  if (author) problems.push(author);
  return { problems, real, reopen: Boolean(author), badDate };
}

// The AI's orders + the pasted messages -> the same orders, checked. A clear order comes back unchanged
// (apart from a long note being cut); an order with problems gets unclear: true and a reason that starts
// with the AI's own reason. Entries that aren't objects pass through: toRows() makes them unclear rows.
// menu gives the seller's name: their "orders" are removed, and prices they wrote are never compared.
export function checkOrders(aiOrders, messages, menu = null) {
  if (!Array.isArray(aiOrders)) throw new TypeError("aiOrders must be an array");
  const removed = new Set(sellerOrders(aiOrders, messages, menu));
  return aiOrders.filter((order) => !removed.has(order)).map((order) => {
    if (!order || typeof order !== "object" || Array.isArray(order)) return order;
    const { problems, real, reopen, badDate } = problemsOf(order, messages, menu);
    // A date that isn't one never reaches a screen or a message: it is "No date yet", and the reason says why.
    const checked = { ...order, ...(badDate && { deliveryDate: null }) };
    if (Array.isArray(order.mentionedPrices)) {
      checked.mentionedPrices = order.mentionedPrices.filter((p) => !isSellerMessage(messages[p?.msg - 1], menu));
    }
    if (typeof order.note !== "string") checked.note = "";
    else if (order.note.length > MAX_NOTE) checked.note = `${order.note.slice(0, MAX_NOTE - 1)}…`;
    if (!problems.length) return checked;

    const aiReason = order.unclear
      ? (typeof order.reason === "string" && order.reason.trim()) || "The AI marked this order unclear."
      : "";
    // A cancelled row is never unclear, so a cancel we can't trust comes back active for the seller to decide.
    return { ...checked, ...(reopen && { status: "active" }), sourceMsgs: real, unclear: true, reason: [aiReason, ...problems].filter(Boolean).join(" ") };
  });
}
