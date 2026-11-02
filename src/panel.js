// The buyer panel (Step 7, PLAN.md Section 10 #1 "Show your work"): the AI's one-line note, and the
// buyer's own messages with the parts that mattered marked, so the seller can see WHY the order looks
// the way it does without trusting the AI blindly. Pure: no files, no network, no clock.
// Marks are worked out by our code from the menu and plain word lists; the AI only chose which
// messages were used (sourceMsgs). Everything comes back as text segments: the page shows them with
// textContent, never as HTML, so a buyer's message can't inject anything.
import { splitMessages } from "./dates.js";
import { currencyWords } from "./prices.js";

const cleanName = (name) => String(name ?? "").trim().toLowerCase();
const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (list) => list.map(escape).sort((a, b) => b.length - a.length).join("|");

// What a buyer's words do, strongest first: where two marks overlap, the earlier kind wins.
function rules(menu) {
  const menuWords = [...menu.items.flatMap((item) => item.aliases), ...(menu.ambiguous ?? []).flatMap((a) => a.words)];
  const money = currencyWords(menu.currency).join("|");
  return [
    ["price", money ? new RegExp(`(?:${money})\\s*\\d+(?:[.,]\\d+)*|\\d+(?:\\.\\d{1,2})?\\s*(?:${money})\\b`, "gi") : null],
    ["change", /\bsame as \p{L}+|\b(?:cancel(?:l?ed|l?ing)?|skip|make it|change(?:d)? to|instead|remove|add)\b/giu],
    ["item", new RegExp(`\\b(?:${words(menuWords)})\\b`, "gi")],
    ["qty", /\b\d+\s*x\b|\b\d+x\b|\b\d+(?:\s+(?:boxes|box|jars|jar|packs|pack|pcs|pieces))?\b(?!\s*(?:inch|in\b|am\b|pm\b|[:.]\d))/gi],
    ["day", /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi],
    ["fulfilment", /\b(?:pick(?:ing)? ?up|collect|deliver(?:y|ed)?)\b/gi],
  ].filter(([, re]) => re);
}

// Text -> [{ text, mark }] (mark null = plain). The segments join back to exactly the same text.
// priceCheck: true marks prices as "price-check" (the buyer's price differs from the menu).
export function highlight(text, { menu, priceCheck = false }) {
  const source = String(text ?? "");
  if (!source) return [];
  const owner = new Array(source.length).fill(null);
  for (const [mark, re] of rules(menu)) {
    for (const match of source.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (owner.slice(start, end).some(Boolean)) continue; // a stronger mark already took (part of) it
      const kind = mark === "price" && priceCheck ? "price-check" : mark;
      for (let i = start; i < end; i++) owner[i] = { kind, start };
    }
  }
  const parts = [];
  for (let i = 0; i < source.length; i++) {
    const kind = owner[i]?.kind ?? null;
    const sameRun = parts.length && parts.at(-1).mark === kind && (kind === null || owner[i].start === owner[i - 1]?.start);
    if (sameRun) parts.at(-1).text += source[i];
    else parts.push({ text: source[i], mark: kind });
  }
  return parts;
}

// One buyer's rows + the chats they came from -> { buyer, note, messages }.
// messages: the buyer's own messages and any message the AI used for the order, in chat order:
// { n, when: "Wed 28 Oct, 10:30", used, parts }. A message that wasn't used gets no marks.
export function buyerPanel(rows, source, menu) {
  if (!rows.length) return { buyer: "", note: "", messages: [] };
  const buyer = rows[0].buyer;
  const note = (rows.find((row) => row.orderStatus === "active") ?? rows[0]).note ?? "";
  if (!source?.text || !source?.chatDate) return { buyer, note, messages: [] };

  const used = new Set(rows.flatMap((row) => (Array.isArray(row.sourceMsgs) ? row.sourceMsgs : [])));
  const openCheck = new Set(rows.filter((row) => row.priceCheck && !row.priceCheck.kept).flatMap((row) => row.priceCheck.msgs ?? []));
  const messages = [];
  for (const msg of splitMessages(source.text, source.chatDate)) {
    const colon = msg.text.indexOf(":");
    const sender = colon > 0 ? msg.text.slice(0, colon) : "";
    if (cleanName(sender) !== cleanName(buyer) && !used.has(msg.n)) continue;
    const body = cleanName(sender) === cleanName(buyer) ? msg.text.slice(colon + 1).trim() : msg.text;
    const isUsed = used.has(msg.n);
    messages.push({
      n: msg.n,
      when: [msg.label?.replace(/ \d{4}$/, ""), msg.time].filter(Boolean).join(", "),
      used: isUsed,
      parts: isUsed ? highlight(body, { menu, priceCheck: openCheck.has(msg.n) }) : [{ text: body, mark: null }],
    });
  }
  return { buyer, note, messages };
}
