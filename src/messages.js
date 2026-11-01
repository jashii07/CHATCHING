// Ready-to-send texts for the chat (Step 10, Part 2), built by CODE only, no AI: AI calls are scarce, and
// the AI's job is reading chats. Names, items, money, dates and links all come from the rows and the menu,
// so a text can never hold a wrong price or a made-up link.
// - message: for a sent invoice, "Hi Lina! Your order: 3 x Classic brownies (RM 54.00), ... Pay here: <link>."
// - reminder: a shorter, polite one with the link, while the invoice is unpaid.
// - question: for an unclear order, built from the menu and the reason, e.g. "Which brownies would you like:
//   Classic (RM 18.00) or Cheese (RM 22.00)?"
// Pure: no files, no network, no clock.
import { toSen, fromSen, formatMoney } from "./money.js";
import { splitMessages } from "./dates.js";
import { soundsCancelled } from "./fallback-parse.js";
import { isSellerMessage } from "./seller.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NO_REMINDER = new Set(["Paid", "Paid (cash/bank)", "Cancelled/Refunded"]);

const cleanName = (buyer) => (typeof buyer === "string" ? buyer.trim() : "");
const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// "Classic brownies (box of 6)" -> "Classic brownies", as on the table's chips.
export const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");
// Intl puts a no-break space after "RM"; a chat message gets a normal one, so it pastes cleanly everywhere.
const money = (amount, menu) => formatMoney(amount, menu.currency).replaceAll(" ", " ");
// "2026-10-31" -> "Sat 31 Oct" (UTC, so no time zone can shift the day). Same words as the table.
function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
// ["a", "b", "c"] -> "a, b and c"; or "or".
const list = (parts, word = "and") => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} ${word} ${parts.at(-1)}`);
const itemOf = (row, menu) => menu.items.find((item) => item.id === row.itemId) ?? null;
const validQty = (qty) => Number.isInteger(qty) && qty >= 1 && qty <= 99;
const days = (rows) => [...new Set(rows.map((row) => row.deliveryDate).filter(Boolean))].sort().map(dayLabel);
const activeOf = (rows) => rows.filter((row) => row.orderStatus === "active");

// The buyer's sent invoice: its payer link, or null while it isn't sent (or was cancelled at PayPal).
function sentLink(rows) {
  const row = rows.find((r) => r.payerLink && r.invoiceStatus && r.invoiceStatus !== "Draft");
  return row && row.invoiceStatus !== "Cancelled/Refunded" ? row : null;
}

// One buyer's rows -> the payment message for their sent invoice, or null.
export function paymentMessage(rows, menu) {
  const active = activeOf(rows);
  const sent = sentLink(active);
  if (!sent || !active.every((row) => row.lineTotal)) return null;
  const lines = active.map((row) => `${row.qty} x ${shortName(itemOf(row, menu)?.name ?? row.itemName)} (${money(row.lineTotal, menu)})`);
  const total = fromSen(active.reduce((sum, row) => sum + toSen(row.lineTotal), 0));
  const when = [active[0].fulfilment, list(days(active))].filter(Boolean).join(" ");
  const parts = [list(lines), active.length > 1 ? `total ${money(total, menu)}` : "", when].filter(Boolean);
  const showQr = active.some((row) => row.fulfilment === "pickup") ? " Show this QR when you pick up." : ""; // the seller sends the QR image with it
  return `Hi ${cleanName(sent.buyer)}! Your order: ${parts.join(", ")}. Pay here: ${sent.payerLink}.${showQr} Thank you!`;
}

// One buyer's rows -> a short, polite reminder while their invoice is unpaid, or null.
// Part paid: we don't know what is left, so no amount is named.
export function reminderMessage(rows, menu) {
  const active = activeOf(rows);
  const sent = sentLink(active);
  if (!sent || NO_REMINDER.has(sent.invoiceStatus) || !active.every((row) => row.lineTotal)) return null;
  const total = fromSen(active.reduce((sum, row) => sum + toSen(row.lineTotal), 0));
  const what = sent.invoiceStatus === "Part paid" ? "your order is not fully paid yet" : `your order (${money(total, menu)}) is still unpaid`;
  return `Hi ${cleanName(sent.buyer)}! A gentle reminder that ${what}. Pay here: ${sent.payerLink}. Thank you!`;
}

// "Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?" for the menu's ambiguous words.
// The choices are the menu items whose aliases hold the word; each is named without it ("Classic").
function whichQuestion(entry, menu) {
  const words = entry.words.map(cleanWords).filter(Boolean);
  const has = (alias) => words.some((word) => ` ${cleanWords(alias)} `.includes(` ${word} `));
  const options = menu.items.filter((item) => item.aliases.some(has));
  if (options.length < 2) return "";
  const label = (item) => {
    const left = shortName(item.name).split(/\s+/).filter((w) => !words.includes(cleanWords(w))).join(" ") || shortName(item.name);
    return `${left.charAt(0).toUpperCase()}${left.slice(1)} (${money(item.price, menu)})`;
  };
  return `Which ${words[0]} would you like: ${list(options.map(label), "or")}?`;
}

// One buyer's rows (+ their own messages' text) -> a question for the buyer, or null when nothing is unclear.
// In this order: they wrote "cancel" -> do they still want it; an ambiguous item -> which one; no quantity
// -> how many; a price that isn't the menu's -> the menu price and the real total. Anything else (a change,
// "same as", a date problem) -> confirm what was read, or ask what they would like.
export function buyerQuestion(rows, menu, texts = []) {
  const active = activeOf(rows);
  if (!active.some((row) => row.unclear)) return null;
  const hi = `Hi ${cleanName(active[0].buyer)}!`;
  if (texts.some(soundsCancelled)) return `${hi} Just to check: would you still like your order, or shall I cancel it?`;

  const parts = [];
  const said = cleanWords(texts.join(" "));
  for (const entry of menu.ambiguous ?? []) {
    const reason = entry.reason.toLowerCase();
    const asked = active.some((row) => row.itemId == null && row.unclear
      && (row.reason.toLowerCase().includes(reason) || entry.words.some((w) => ` ${said} `.includes(` ${cleanWords(w)} `))));
    const question = asked ? whichQuestion(entry, menu) : "";
    if (question) parts.push(question);
  }
  const noQty = active.filter((row) => itemOf(row, menu) && !validQty(row.qty)).map((row) => shortName(itemOf(row, menu).name));
  if (noQty.length) parts.push(`Just to check: how many ${list([...new Set(noQty)])} would you like?`);

  const priced = active.filter((row) => row.priceCheck && !row.priceCheck.kept && itemOf(row, menu));
  if (priced.length) {
    const each = [...new Set(priced.map((row) => row.itemId))].map((id) => {
      const item = menu.items.find((it) => it.id === id);
      const name = shortName(item.name);
      return `${name} ${name.endsWith("s") ? "are" : "is"} ${money(item.price, menu)} each`;
    });
    const total = active.every((row) => row.lineTotal)
      ? `, so your total is ${money(fromSen(active.reduce((sum, row) => sum + toSen(row.lineTotal), 0)), menu)}` : "";
    parts.push(`Just to check: ${list(each)}${total}. Is that ok?`);
  }
  if (parts.length) return `${hi} ${parts.join(" ")}`;

  const known = active.filter((row) => itemOf(row, menu) && validQty(row.qty));
  if (!known.length) return `${hi} Just to check: which items would you like, and how many of each?`;
  const when = days(known).length ? ` for ${list(days(known))}` : "";
  return `${hi} Just to check: your order is ${list(known.map((row) => `${row.qty} x ${shortName(itemOf(row, menu).name)}`))}${when}. Is that right?`;
}

// Every buyer in the table (first-seen order, "Lina" and "lina" together, as in orders.js) ->
// { buyer, message, reminder, question }; each is a text to copy, or null. source = the pasted chats
// ({ text, chatDate }), so a question can use the buyer's own words; without it, only the rows are used.
export function buyerMessages(rows, source, menu) {
  let chat = [];
  try {
    if (source?.text && source?.chatDate) chat = splitMessages(source.text, source.chatDate);
  } catch {
    chat = []; // a broken saved source only means the question can't use the buyer's words
  }
  const groups = new Map();
  for (const row of rows) {
    const key = cleanName(row.buyer).toLowerCase();
    if (!groups.has(key)) groups.set(key, { buyer: row.buyer, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(({ buyer, rows: own }) => {
    const used = new Set(own.flatMap((row) => (Array.isArray(row.sourceMsgs) ? row.sourceMsgs : [])));
    const texts = chat.filter((msg) => used.has(msg.n) && !isSellerMessage(msg, menu)).map((msg) => msg.text);
    return { buyer, message: paymentMessage(own, menu), reminder: reminderMessage(own, menu), question: buyerQuestion(own, menu, texts) };
  });
}
