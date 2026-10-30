// One call to Gemini's generateContent (Step 7). Shared by the app's real AI mode (src/ai.js) and the
// spike script, so both send the request the same way. The key goes in a header, never in the URL, and
// is never logged. Returns the raw reply text unchanged (it is cached byte for byte).
// signal and now exist for the tests (a fake timeout and a fake clock); normally timeoutMs is enough.
import { PARSE_MODEL } from "./ai-prompt.js";

export const MAIN_MODEL = PARSE_MODEL;
export const BACKUP_MODEL = "gemini-3.8-flash"; // its own 20 calls a day (DECISIONS.md, 25 Oct)

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// A failed call. status is Google's HTTP status, 504 for our own timeout, 0 for a network error.
// retryable = worth trying again or with the backup model (overloaded, rate limit, timeout, network).
export class GeminiError extends Error {
  constructor(message, { status, model, seconds }) {
    super(message);
    this.name = "GeminiError";
    Object.assign(this, { status, model, seconds, retryable: [0, 429, 500, 503, 504].includes(status) });
  }
}

export async function callGemini({ apiKey, model, body, fetch = globalThis.fetch, timeoutMs, signal = AbortSignal.timeout(timeoutMs), now = () => performance.now() }) {
  const start = now();
  const seconds = () => Number(((now() - start) / 1000).toFixed(1));
  let res;
  let text;
  try {
    res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    throw new GeminiError(timedOut ? `No answer within ${Number((timeoutMs / 1000).toFixed(1))} s.` : `Network error: ${err?.cause?.code ?? err?.message}`,
      { status: timedOut ? 504 : 0, model, seconds: seconds() });
  }
  if (!res.ok) {
    let error = {};
    try {
      error = JSON.parse(text).error ?? {};
    } catch {}
    throw new GeminiError(`HTTP ${res.status}${error.status ? ` ${error.status}` : ""}: ${String(error.message ?? text).slice(0, 200)}`,
      { status: res.status, model, seconds: seconds() });
  }
  return { text, model, seconds: seconds() };
}
