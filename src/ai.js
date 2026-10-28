// The AI side of the app. For now, MOCK mode only: it returns Gemini's REAL reply from the AI reality
// check (Step 3b), saved unchanged in data/ai-cache/, so the mock behaves like the real AI, mistakes
// included, and costs 0 calls (PLAN.md Section 6). The real call, cache, timeout and retries come in
// Steps 7 and 9; they will use the same prompt (src/ai-prompt.js), the same key and replyToOrders().
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replyToOrders } from "./ai-prompt.js";

const DEMO_REPLY = fileURLToPath(new URL("../data/ai-cache/demo-parse.json", import.meta.url));
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);
const DEMO_ANSWERS = new URL("../data/expected-orders.json", import.meta.url);

export const MOCK_UNKNOWN = "Mock mode only knows the demo chats - the real AI comes in Step 7.";
const NOT_BUILT = {
  real: "Reading with the real AI comes in Step 7. Set AI_MODE=mock to read the demo chats for now.",
  off: "Reading without AI comes in Step 12. Set AI_MODE=mock to read the demo chats for now.",
};

// The cache key for one parse: a hash of the Chat date + the chat text. Line endings, blank lines and
// spaces at the ends of lines don't change it, so the same chats pasted again find the same saved reply.
// The Chat date is part of the key: the same chats on another day are another question (PLAN.md Section 6).
export function parseKey(text, chatDate) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return createHash("sha256").update(`${chatDate}\n${lines.join("\n")}`).digest("hex");
}

// Mock mode's saved replies: cache key -> file. Only the demo chats for now; Step 7 adds the real cache.
export function demoReplies() {
  const { chatDate } = JSON.parse(readFileSync(DEMO_ANSWERS, "utf8"));
  return new Map([[parseKey(readFileSync(DEMO_CHATS, "utf8"), chatDate), DEMO_REPLY]]);
}

// A saved reply -> the AI's orders. A missing or broken file is a clear error, never a silent
// fallback to made-up data. (The store also uses this for the demo rows on first start.)
export function mockParse(file = DEMO_REPLY) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Could not read the saved AI reply ${file}: ${err.message}`);
  }
  try {
    return replyToOrders(raw);
  } catch (err) {
    throw new Error(`The saved AI reply ${file} is broken: ${err.message}`);
  }
}

// The app's AI. parse() -> { orders } (the AI's raw orders, not yet checked) or { notice } (a friendly
// message for the seller). A broken reply throws; the route turns that into a notice.
export function createAi({ mode, replies = demoReplies() }) {
  return {
    async parse({ text, chatDate }) {
      if (mode !== "mock") return { notice: NOT_BUILT[mode] ?? MOCK_UNKNOWN };
      const file = replies.get(parseKey(text, chatDate));
      return file ? { orders: mockParse(file) } : { notice: MOCK_UNKNOWN };
    },
  };
}
