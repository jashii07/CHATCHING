// What the seller should do next (user test, 6 Nov: my friend didn't know what to do in which order, or that each
// buyer needs their message). One short line under the step guide, worked out from the table, plus what the seller
// already did on this page (copied a buyer's question or message). Pure code: the page (public/app.js) and the
// tests (test/next-step.test.js) use this same file.
//
// buyers: one per buyer, as the page builds them: { key, cancelled, unclear, toSend, payerLink, status, collected, answer }.
// did: a Set of "question:<key>" and "message:<key>": the seller copied that buyer's question, or their message
//   or reminder (both hold the buyer's order page).
// -> { key, text, buyer }. key: start | fix | send | message | watch | pickup | done | nothing. buyer: the key of
//    the buyer the line is about (the first one still to ask or to message), else null.

export const NEXT_TEXT = {
  start: "New here? Try the demo, or paste your chats below, then click Read orders.",
  fix: "Next: fix the amber rows. Copy question asks the buyer what's missing.",
  fixWaiting: "Next: when a buyer answers your question, tap their amber row and fix it.",
  send: "Next: send the invoices. One PayPal invoice for each clear order.",
  message: "Next: send each buyer their message. Tap Copy message on each row and paste it into your chat with that buyer. It has their order page, Pay button and QR code.",
  watch: "Next: watch for Paid (Refresh status asks PayPal), or tap a buyer to record a cash payment.",
  pickup: "At pickup: tap Pickup scan and scan the buyer's QR, then tap Collected.",
  done: "All paid and handed over. Start a New batch for the next day's chats.",
  nothing: "Every order here is cancelled. Paste new chats, then click Read orders.",
};

const isPaid = (buyer) => String(buyer.status).startsWith("Paid"); // "Paid" or "Paid (cash/bank)"
// Sent and still waiting for money ("Sent", "Part paid"); a cancelled or refunded invoice waits for nothing.
const isOpen = (buyer) => Boolean(buyer.payerLink) && !isPaid(buyer) && !String(buyer.status).startsWith("Cancelled");

// Sent buyers who may not have their order page yet: the seller hasn't copied their message or reminder here,
// and they haven't answered on the page or paid (either proves they have it).
export function waitingForMessage(buyers, did = new Set()) {
  return buyers.filter((buyer) => !buyer.cancelled && isOpen(buyer) && !buyer.answer && !did.has(`message:${buyer.key}`));
}

export function nextStep(buyers, did = new Set()) {
  const say = (key, buyer = null, text = NEXT_TEXT[key]) => ({ key, text, buyer });
  if (!buyers.length) return say("start");
  const active = buyers.filter((buyer) => !buyer.cancelled);
  const amber = active.filter((buyer) => buyer.unclear && !buyer.payerLink);
  const unasked = amber.filter((buyer) => !did.has(`question:${buyer.key}`));
  const toSend = active.some((buyer) => buyer.toSend);
  const sent = active.filter((buyer) => buyer.payerLink);

  // Before any invoice: check first, then charge. A buyer already asked doesn't hold up the clear orders.
  if (!sent.length) {
    if (unasked.length) return say("fix", unasked[0].key);
    if (toSend) return say("send");
    if (amber.length) return say("fix", amber[0].key, NEXT_TEXT.fixWaiting);
    return say("nothing");
  }
  // Invoices are out: anything still to send (a retry, a fixed buyer), then the buyers waiting for their message,
  // then questions not asked yet, then money, then the hand-over.
  if (toSend) return say("send");
  const toMessage = waitingForMessage(active, did);
  if (toMessage.length) return say("message", toMessage[0].key);
  if (unasked.length) return say("fix", unasked[0].key);
  if (sent.some(isOpen)) return say("watch");
  if (sent.some((buyer) => isPaid(buyer) && !buyer.collected)) return say("pickup");
  if (amber.length) return say("fix", amber[0].key, NEXT_TEXT.fixWaiting);
  return say("done");
}
