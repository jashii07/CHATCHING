// The AI side of the app. For now, MOCK mode only: it returns Gemini's REAL reply from the AI reality
// check (Step 3b), saved unchanged in data/ai-cache/, so the mock behaves like the real AI, mistakes
// included, and costs 0 calls (PLAN.md Section 6). The real call, cache, timeout and retries come in
// Steps 7 and 9; they will use the same prompt (src/ai-prompt.js) and the same replyToOrders().
import { readFileSync } from "node:fs";
import { replyToOrders } from "./ai-prompt.js";

const DEMO_REPLY = new URL("../data/ai-cache/demo-parse.json", import.meta.url);

// The demo chats' orders, from Gemini's saved reply. A missing or broken file is a clear error (the
// server then refuses to start with this message), never a silent fallback to made-up data.
export function mockParse(file = DEMO_REPLY) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Could not read the saved AI reply data/ai-cache/demo-parse.json: ${err.message}`);
  }
  try {
    return replyToOrders(raw);
  } catch (err) {
    throw new Error(`The saved AI reply data/ai-cache/demo-parse.json is broken: ${err.message}`);
  }
}
