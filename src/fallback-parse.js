// Reading chats WITHOUT the AI (Step 10, Part 1), for when Gemini is busy, too slow or today's reads are used
// up, so a seller (or a judge) never hits a dead end. Never automatic: the seller clicks "Read without AI".
// Careful, not clever: it reads simple orders ("2 boxes of classic brownies for saturday") and makes everything
// else unclear with a reason: changes, cancellations, "same as", unknown or ambiguous items, a missing
// quantity, two days. It returns orders in the AI's shape (PLAN.md Section 5), so they go through the same
// checks (checkOrders, toRows) and every price comes from the menu, as always.
// Pure: no files, no network, no clock. The messages (with their dates) come from splitMessages() in dates.js.
import { matchMenuItem } from "./orders.js";
import { resolveDayWord } from "./dates.js";
import { currencyWords } from "./prices.js";

// Same cleaning as orders.js: lowercase words only, so "Choc-Chip!" and "choc chip" read the same.
const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");
const quote = (text) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(clean.length > 40 ? `${clean.slice(0, 39)}…` : clean);
};

// "Lina: hi!" -> Lina. A name has letters, no digits and at most 5 words, so "pick up at 3:30" has no sender.
const SENDER = /^([^:\n]{1,40}):(?:\s|$)/;

// What a message does, read on its cleaned words ("don't" is "don t"). The strongest one found is reported.
const CANCEL = /\b(?:cancel(?:led)?|batal|tak jadi|no need|(?:don t|do not) want|never ?mind|not needed)\b/;
const SAME = /\b(?:same (?:as|like|for me|here|order)|sama (?:macam|mcm|dengan)|me too)\b/;
const CHANGE = /\b(?:make it|change[ds]?|instead|actually|wait|add(?:ed)?|also|another|more|extra|skip|remove|minus|less|swap|replace|tukar|tambah|update)\b/;
// Also used by src/messages.js: an unclear buyer who wrote "cancel" is asked whether they still want it.
export const soundsCancelled = (text) => CANCEL.test(cleanWords(text));
const PICKUP = /\b(?:pick ?up|picking up|collect|ambil)\b/;
const DELIVERY = /\b(?:deliver(?:y|ed)?|hantar|drop off)\b/;

// Numbers that are not quantities, taken out before counting: times, dates, sizes. "box of 6" keeps the box.
const TIME = /\b\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\b\.?)?|\b\d{1,2}\s*[ap]\.?m\b\.?/gi;
const DATE_NUMBERS = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const SIZE = /\b\d+(?:\.\d+)?\s*-?\s*(?:inch(?:es)?|cm)\b|\b\d+"/gi;
const UNITS = ["box", "boxes", "jar", "jars", "pack", "packs", "packet", "packets", "pcs", "pc", "piece", "pieces", "tub", "tubs", "tray", "trays", "set", "sets", "tin", "tins", "kotak", "bekas", "balang", "biji"];
const BOX_OF = new RegExp(`\\b(${UNITS.join("|")})\\s+of\\s+\\d+\\b`, "gi");
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, sembilan: 9, sepuluh: 10,
};
// A message is read in phrases: "2x cheese brownie + 1 classic, Saturday. Classic is RM15 right?" has 4.
// A dot between digits ("RM15.50", "3.30pm") doesn't split.
const PHRASE_BREAK = /[,;!?+&\n]+|\.(?!\d)|(?<!\d)\.|\b(?:and|dan|plus|n)\b/i;

// The menu's price pattern ("RM15", "15 MYR"): the currency's own code and symbol, never hard-coded.
function pricePattern(menu) {
  const money = currencyWords(menu.currency).join("|");
  return money ? new RegExp(`(?:${money})\\s*\\d+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?\\s*(?:${money})\\b`, "gi") : null;
}

// The quantities in a phrase: digits ("2", "2x", "x2"; 4+ digits are phone numbers, not quantities),
// number words ("two", "dua"), and "a"/"an" right before a unit or an item ("a jar of cookies").
function quantities(words, itemStarts) {
  const found = [];
  const list = words.replace(/\b(\d+)x\b/g, "$1").replace(/\bx(\d+)\b/g, "$1").split(" ");
  list.forEach((word, i) => {
    if (/^\d{1,3}$/.test(word)) found.push(Number(word));
    else if (Object.hasOwn(NUMBER_WORDS, word)) found.push(NUMBER_WORDS[word]);
    else if ((word === "a" || word === "an") && (UNITS.includes(list[i + 1]) || itemStarts.has(list[i + 1]))) found.push(1);
  });
  return [...new Set(found)];
}

// One phrase -> { line, price, problem, ambiguous }: at most one of each. line = { itemId, qty } (qty may be
// null); price = the text of a price the buyer wrote; ambiguous = the menu's reason ("Which brownies...?").
function readPhrase(raw, menu, prices, itemStarts) {
  const out = { line: null, price: null, problem: "", ambiguous: "" };
  let text = raw;
  if (prices) text = text.replace(prices, (match) => ((out.price ??= match.trim()), " "));
  text = text.replace(TIME, " ").replace(DATE_NUMBERS, " ").replace(SIZE, " ").replace(BOX_OF, "$1");
  const words = cleanWords(text);
  if (!words) return out;
  const qty = quantities(words, itemStarts);
  const match = matchMenuItem(words, menu);
  const ambiguous = (menu.ambiguous ?? []).find((a) => a.reason === match.reason);
  if (out.price) out.price = { text: out.price, itemId: match.itemId ?? null }; // about this phrase's item, if any

  if (match.itemId) {
    const name = shortName(menu.items.find((item) => item.id === match.itemId).name);
    // "Classic is RM15 right?": a price about the item, not an order line.
    if (!qty.length && out.price) {
      // nothing more: the price is reported, and the code compares it with the menu
    } else {
      out.line = { itemId: match.itemId, qty: qty.length === 1 ? qty[0] : null };
      if (!qty.length) out.problem = `no quantity for ${name}`;
      if (qty.length > 1) out.problem = `more than one number for ${name}`;
    }
  } else if (ambiguous) {
    out.line = { itemId: null, qty: qty.length === 1 ? qty[0] : null };
    out.ambiguous = ambiguous.reason.charAt(0).toLowerCase() + ambiguous.reason.slice(1);
  } else if (match.reason.startsWith("More than one menu item")) {
    out.problem = `${quote(raw)} names more than one menu item`;
  } else if (qty.length) {
    out.problem = `${quote(raw)} has a number but no menu item`;
  }
  return out;
}

// One message -> what it says: sender, order lines, prices, problems, days, pickup/delivery, change words.
function readMessage(msg, menu, prices, itemStarts) {
  const text = String(msg.text ?? "");
  const m = text.match(SENDER);
  const name = m?.[1].trim() ?? "";
  const named = name && /\p{L}/u.test(name) && !/\d/.test(name) && name.split(/\s+/).length <= 5;
  const body = named ? text.slice(m[0].length) : text;
  const words = cleanWords(body);

  const read = { n: msg.n, sender: named ? name : "", lines: [], prices: [], problems: [], ambiguous: [], dates: [], fulfilment: [] };
  for (const phrase of body.split(PHRASE_BREAK)) {
    if (!phrase?.trim()) continue;
    const { line, price, problem, ambiguous } = readPhrase(phrase, menu, prices, itemStarts);
    if (line) read.lines.push(line);
    if (price) read.prices.push({ ...price, msg: msg.n });
    if (problem) read.problems.push(problem);
    if (ambiguous) read.ambiguous.push(ambiguous);
  }

  // Day words: "saturday", "esok", "tomorrow" from the message's own date; "today" is that date itself.
  const list = words.split(" ");
  list.forEach((word, i) => {
    if (!msg.date) return; // an impossible timestamp: checkOrders already reports it
    const day = word === "today" || word === "tonight" ? msg.date : resolveDayWord(word, msg.date);
    if (!day) return;
    if (list[i - 1] === "next") read.problems.push(`"next ${word}" could mean two dates`);
    read.dates.push(day);
  });
  if (PICKUP.test(words)) read.fulfilment.push("pickup");
  if (DELIVERY.test(words)) read.fulfilment.push("delivery");
  read.flag = CANCEL.test(words) ? "this buyer may have cancelled"
    : SAME.test(words) ? 'this buyer wrote "same as" another order'
    : CHANGE.test(words) ? "this buyer changed their order" : "";
  // Anything that looks like part of an order. Messages with no name and none of this are skipped
  // (e.g. "Messages are end-to-end encrypted"); a named buyer always gets an order, even an unclear one.
  read.orderLike = Boolean(read.lines.length || read.prices.length || read.problems.length || read.ambiguous.length || read.flag);
  return read;
}

// One buyer's messages -> one order in the AI's shape.
function buildOrder(buyer, reads) {
  const lines = [];
  for (const line of reads.flatMap((r) => r.lines)) {
    const same = line.itemId && lines.find((other) => other.itemId === line.itemId);
    if (!same) lines.push({ ...line });
    else if (line.qty != null) same.qty = line.qty; // the last quantity the reader saw
  }
  const dates = [...new Set(reads.flatMap((r) => r.dates))];
  const ways = new Set(reads.flatMap((r) => r.fulfilment));
  const flags = ["this buyer may have cancelled", 'this buyer wrote "same as" another order', "this buyer changed their order"];
  const flag = flags.find((f) => reads.some((r) => r.flag === f));

  // A change, cancellation or "same as" is the main reason; the seller reads the messages anyway, so the
  // smaller problems are left out then. Clauses that end with "?" go last, so the reason reads as one line.
  const clauses = [];
  if (!buyer) clauses.push(reads.length === 1 ? "this message has no buyer name" : "these messages have no buyer name");
  if (flag) clauses.push(flag);
  else {
    if (reads.filter((r) => r.lines.length).length > 1) clauses.push("this buyer wrote items in more than one message");
    clauses.push(...reads.flatMap((r) => r.problems));
    if (dates.length > 1) clauses.push("more than one day is mentioned");
  }
  clauses.push(...new Set(reads.flatMap((r) => r.ambiguous)));
  const unique = [...new Set(clauses)];
  const reason = unique.length ? `read without AI, ${unique.join("; ")}${unique.at(-1).endsWith("?") ? "" : "."}` : "";

  return {
    buyer,
    status: "active", // never cancelled here: that is the seller's call
    sourceMsgs: reads.map((r) => r.n),
    items: lines,
    deliveryDate: dates.length === 1 ? dates[0] : null,
    fulfilment: ways.size === 1 ? [...ways][0] : null,
    unclear: Boolean(reason),
    reason,
    note: "",
    mentionedPrices: reads.flatMap((r) => r.prices),
  };
}

// The messages of one paste (splitMessages) + the menu -> one order per buyer, in first-seen order.
// "Lina" and "lina" are one buyer, shown with the first spelling (as groupByBuyer does).
export function fallbackParse(messages, menu) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const prices = pricePattern(menu);
  const itemStarts = new Set([
    ...menu.items.flatMap((item) => item.aliases),
    ...(menu.ambiguous ?? []).flatMap((a) => a.words),
  ].map((alias) => cleanWords(alias).split(" ")[0]).filter(Boolean));

  const buyers = new Map();
  for (const msg of messages) {
    const read = readMessage(msg, menu, prices, itemStarts);
    if (!read.sender && !read.orderLike) continue;
    const key = read.sender.toLowerCase();
    if (!buyers.has(key)) buyers.set(key, { buyer: read.sender, reads: [] });
    buyers.get(key).reads.push(read);
  }
  return [...buyers.values()].map(({ buyer, reads }) => buildOrder(buyer, reads));
}
