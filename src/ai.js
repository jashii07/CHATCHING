// The AI side of the app (PLAN.md Section 6).
// - MOCK mode returns saved real Gemini replies from data/ai-cache/ (0 calls): the demo chats' reply is
//   Gemini's real answer, saved unchanged, so the mock behaves like the real AI, mistakes included.
// - REAL mode (Step 7): the same saved demo reply first (0 calls), then our own cache of earlier real
//   replies (data/runtime/ai-cache/, git-ignored: real chats are never committed), and only then ONE
//   batched call: the main model, and the backup model if the main one is overloaded, rate-limited or
//   too slow. The raw reply is cached byte for byte under the hash of the Chat date + chat text.
// - Step 9: ONE time budget for the whole parse (90 s since 1 Nov; the main model gets up to 60 s, the
//   backup the rest), one short-wait retry on 503/429 only if a real read still fits, never more than 3 calls, and
//   the daily counter (src/usage.js): every call is counted before it starts; at 0 nothing is called.
//   Step 11: if Google itself answers "daily limit reached" (our count starts again at 0 when Render
//   restarts), that model is marked used up for the day and the seller gets the friendly "used up" words.
//   When the AI fails, the page offers "Read without AI" (src/fallback-parse.js, Step 10); never automatic.
// The key is passed in (from config), sent in a header by src/gemini.js, and never logged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRequest, replyToOrders } from "./ai-prompt.js";
import { BACKUP_MODEL, GeminiError, MAIN_MODEL, callGemini } from "./gemini.js";
import { createUsage, resetHourMalaysia } from "./usage.js";

const DEMO_REPLY = fileURLToPath(new URL("../data/ai-cache/demo-parse.json", import.meta.url));
const DEMO_CHATS = new URL("../data/demo-chats.txt", import.meta.url);
const DEMO_ANSWERS = new URL("../data/expected-orders.json", import.meta.url);
export const RUNTIME_CACHE = fileURLToPath(new URL("../data/runtime/ai-cache/", import.meta.url));

// The time budget (DECISIONS.md, 30 Oct; raised 1 Nov for longer pastes). On 29 Oct both models were busy
// and it took 47 s to fail.
export const PARSE_BUDGET_MS = 90_000; // the most a seller waits for one parse, everything included
export const MAIN_SHARE_MS = 60_000; // the main model's part; the backup always keeps at least 30 s
export const RETRY_WAIT_MS = 2_000; // a 503/429 comes back fast; wait a moment before asking again
export const MIN_TRY_MS = 20_000; // a retry needs this much left: real reads took 17.6 to 28.2 s
export const MAX_CALLS = 3; // per parse, retries and backup included

export const MOCK_UNKNOWN = "Mock mode only knows the demo chats. Set AI_MODE=real to read other chats with Gemini.";
export const NO_KEY = "The AI key is missing (GEMINI_API_KEY), so only the demo chats can be read.";
export const AI_BUSY = "The AI is busy right now. Please try again in a minute, or click Load demo to see how it works.";
export const AI_REFUSED = "The AI could not read these chats, so your orders were not changed.";
export const usedUp = (ms) => `Today's free AI reads are used up. Try again after ${resetHourMalaysia(ms)} Malaysia time, or click Load demo.`;
const NOT_BUILT = { off: "AI reading is switched off on this server (AI_MODE=off), so the chats can only be read without AI." };

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
// the route turns that into a notice. onStage("backup") tells the page the main model failed.
// now, sleep and timeoutSignal are the clock, the wait and the timer: the tests pass fake ones, so they
// run every path (timeouts included) in milliseconds without waiting.
export function createAi({
  mode,
  apiKey = "",
  replies = demoReplies(),
  cacheDir = RUNTIME_CACHE,
  models = [MAIN_MODEL, BACKUP_MODEL],
  fetch = globalThis.fetch,
  now = Date.now,
  usage = createUsage({ models, now }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  budgetMs = PARSE_BUDGET_MS,
  mainShareMs = MAIN_SHARE_MS,
  maxCalls = MAX_CALLS,
  log = console.log,
}) {
  const cacheFile = (key) => join(cacheDir, `parse-${key}.json`);

  async function realParse({ text, chatDate, menu, onStage, validate }) {
    const key = parseKey(text, chatDate);
    if (existsSync(cacheFile(key))) return { orders: mockParse(cacheFile(key)), from: "cache" };
    if (!apiKey) return { notice: NO_KEY };
    const usable = models.filter((model) => usage.left(model) > 0);
    if (!usable.length) return { notice: usedUp(now()) };
    const { body } = parseRequest({ paste: text, chatDate, menu });

    const start = now();
    const deadline = start + budgetMs;
    let calls = 0;
    let retried = false;
    let dailyLimitHit = false;
    for (const [i, model] of usable.entries()) {
      // The last model we can use gets everything that is left; any model before it only its share.
      const end = i < usable.length - 1 ? Math.min(start + mainShareMs, deadline) : deadline;
      if (calls > 0) onStage("backup");
      while (calls < maxCalls && end - now() > 0 && usage.left(model) > 0) {
        const timeoutMs = end - now();
        calls += 1;
        usage.take(model); // counted before it starts: a failed call may count at Google too
        let reply;
        try {
          reply = await callGemini({ apiKey, model, body, fetch, timeoutMs, signal: timeoutSignal(timeoutMs), now });
        } catch (err) {
          if (!(err instanceof GeminiError)) throw err;
          log(`Warning: Gemini ${model} failed after ${err.seconds} s (${err.message}).`);
          if (!err.retryable) return { notice: AI_REFUSED };
          // Google's own daily limit for this model is reached (our count may be low after a restart):
          // never call it again today, no retry, straight to the next model.
          if (err.dailyLimit) {
            usage.useUp(model);
            dailyLimitHit = true;
            break;
          }
          // Busy or rate-limited: ask the same model once more, but only if a real read still fits after
          // the wait. A timeout or network error goes straight to the next model (no 90 s waits).
          // A retry must also leave a call for every model still to come (with maxCalls 2: main, then backup).
          const busy = err.status === 503 || err.status === 429;
          const callsAfter = usable.length - 1 - i;
          if (busy && !retried && calls + 1 + callsAfter <= maxCalls && end - now() - RETRY_WAIT_MS >= MIN_TRY_MS) {
            retried = true;
            await sleep(RETRY_WAIT_MS);
            continue;
          }
          break;
        }
        const orders = replyToOrders(reply.text); // throws on a broken reply: nothing is cached then
        validate(orders); // so does one our own checks can't handle: the same chats get a fresh read next time
        mkdirSync(cacheDir, { recursive: true });
        const tmp = `${cacheFile(key)}.tmp`;
        writeFileSync(tmp, reply.text);
        renameSync(tmp, cacheFile(key));
        log(`Gemini ${model} read the chats in ${reply.seconds} s.`);
        return { orders, from: model };
      }
    }
    // Google said "daily limit" and no model is left: the used-up words, not "try again in a minute".
    if (dailyLimitHit && usage.totalLeft() === 0) return { notice: usedUp(now()) };
    return { notice: AI_BUSY };
  }

  return {
    // The demo reply and cached chats come first, so they still work when the counter is at 0.
    // validate(orders): the caller's checks, run before a real reply is cached. It throws to refuse the reply.
    async parse({ text, chatDate, menu, onStage = () => {}, validate = () => {} }) {
      if (mode !== "mock" && mode !== "real") return { notice: NOT_BUILT[mode] ?? MOCK_UNKNOWN };
      const file = replies.get(parseKey(text, chatDate));
      if (file) return { orders: mockParse(file), from: "saved" };
      if (mode === "mock") return { notice: MOCK_UNKNOWN };
      return realParse({ text, chatDate, menu, onStage, validate });
    },
    callsLeft: () => usage.totalLeft(),
  };
}
