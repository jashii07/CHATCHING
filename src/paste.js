// A pasted chat + its Chat date -> its messages, or a friendly notice when it can't be read yet.
// Pure: no files, no network. Limits from PLAN.md Section 6 keep one AI call small and cheap.
// A notice is not a crash and not an error: the seller just pastes again.
import { splitMessages } from "./dates.js";

export const MAX_MESSAGES = 50;
export const MAX_CHARS = 10_000;

const count = (n) => n.toLocaleString("en");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// -> { messages, notice: "" } when it can be read, or { notice } when it can't.
export function readPaste(text, chatDate) {
  if (typeof text !== "string" || !text.trim()) return { notice: "Paste some chat messages first." };
  // Characters first: a huge paste is refused before we split it.
  if (text.length > MAX_CHARS) {
    return { notice: `That paste is ${count(text.length)} characters. ChatChing reads up to ${count(MAX_CHARS)} at a time, so please paste fewer messages.` };
  }
  let messages;
  try {
    if (!ISO_DATE.test(chatDate)) throw new RangeError("no chat date");
    messages = splitMessages(text, chatDate);
  } catch {
    return { notice: "Choose the Chat date (the day these chats are from) first." };
  }
  if (messages.length > MAX_MESSAGES) {
    return { notice: `That's ${messages.length} messages. ChatChing reads up to ${MAX_MESSAGES} at a time, so please paste fewer.` };
  }
  return { messages, notice: "" };
}
