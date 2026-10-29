// The AI side of the app (PLAN.md Section 6).
// - MOCK mode returns saved real Gemini replies from data/ai-cache/ (0 calls): the demo chats' reply is
//   Gemini's real answer, saved unchanged, so the mock behaves like the real AI, mistakes included.
// - REAL mode (Step 7): the same saved demo reply first (0 calls), then our own cache of earlier real
//   replies (data/runtime/ai-cache/, git-ignored: real chats are never committed), and only then ONE
//   batched call: the main model, and the backup model if the main one is overloaded, rate-limited or
//   too slow. The raw reply is cached byte for byte under the hash of the Chat date + chat text.
//   Waiting between retries, the daily counter and the non-AI fallback come in Steps 9 and 12.
// The key is passed in (from config), sent in a header by src/gemini.js, and never logged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRequest, replyToOrders } from "./ai-prompt.js";
import { BACKUP_MODEL, GeminiError, MAIN_MODEL, callGemini } from "./gemini.js";

const DEMO_REPLY = fileURLToPath(new URL("../data/ai-cache/demo-parse.json", import.meta.url));
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);
const DEMO_ANSWERS = new URL("../data/expected-orders.json", import.meta.url);
const RUNTIME_CACHE = fileURLToPath(new URL("../data/runtime/ai-cache/", import.meta.url));
export const PARSE_TIMEOUT_MS = 45_000; // Step 3b measured 17.6 s for 15 messages (DECISIONS.md, 27 Oct)

export const MOCK_UNKNOWN = "Mock mode only knows the demo chats. Set AI_MODE=real to read other chats with Gemini.";
export const NO_KEY = "The AI key is missing (GEMINI_API_KEY), so only the demo chats can be read.";
export const AI_BUSY = "The AI is busy right now, so your orders were not changed. Please try again in a minute.";
export const AI_REFUSED = "The AI could not read these chats, so your orders were not changed.";
const NOT_BUILT = { off: "Reading without AI comes in Step 12. Set AI_MODE=mock to read the demo chats for now." };

// The cache key for one parse: a hash of the Chat date + the chat text. Line endings, blank lines and
// spaces at the ends of lines don't change it, so the same chats pasted again find the same saved reply.
// The Chat date is part of the key: the same chats on another day are another question (PLAN.md Section 6).
export function parseKey(text, chatDate) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return createHash("sha256").update(`${chatDate}\n${lines.join("\n")}`).digest("hex");
}

// The saved replies that ship with the app: cache key -> file. Only the demo chats.
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

// The app's AI. parse() -> { orders, from } (the AI's raw orders, not yet checked; from = "saved",
// "cache" or the model name) or { notice } (a friendly message for the seller). A broken reply throws;
// the route turns that into a notice.
export function createAi({
  mode,
  apiKey = "",
  replies = demoReplies(),
  cacheDir = RUNTIME_CACHE,
  models = [MAIN_MODEL, BACKUP_MODEL],
  fetch = globalThis.fetch,
  timeoutMs = PARSE_TIMEOUT_MS,
  log = console.log,
}) {
  const cacheFile = (key) => join(cacheDir, `parse-${key}.json`);

  async function realParse({ text, chatDate, menu }) {
    const key = parseKey(text, chatDate);
    if (existsSync(cacheFile(key))) return { orders: mockParse(cacheFile(key)), from: "cache" };
    if (!apiKey) return { notice: NO_KEY };
    const { body } = parseRequest({ paste: text, chatDate, menu });
    for (const model of models) {
      let reply;
      try {
        reply = await callGemini({ apiKey, model, body, fetch, timeoutMs });
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        log(`Warning: Gemini ${model} failed after ${err.seconds} s (${err.message}).`);
        if (err.retryable) continue; // overloaded, rate limit, timeout: the next model has its own quota
        return { notice: AI_REFUSED };
      }
      const orders = replyToOrders(reply.text); // throws on a broken reply: nothing is cached then
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cacheFile(key)}.tmp`;
      writeFileSync(tmp, reply.text);
      renameSync(tmp, cacheFile(key));
      log(`Gemini ${model} read the chats in ${reply.seconds} s.`);
      return { orders, from: model };
    }
    return { notice: AI_BUSY };
  }

  return {
    async parse({ text, chatDate, menu }) {
      if (mode !== "mock" && mode !== "real") return { notice: NOT_BUILT[mode] ?? MOCK_UNKNOWN };
      const file = replies.get(parseKey(text, chatDate));
      if (file) return { orders: mockParse(file), from: "saved" };
      if (mode === "mock") return { notice: MOCK_UNKNOWN };
      return realParse({ text, chatDate, menu });
    },
  };
}
