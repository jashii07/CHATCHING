// Smoke test: proves the Gemini API key works by sending one tiny prompt.
// Run: node --env-file=.env scripts/smoke-gemini.mjs
// Optional: set GEMINI_MODEL in .env to try another model.
// Never prints the API key.

// gemini-3.6-flash: stable, free tier, and answered in ~3.5s on 2026-10-25.
// gemini-3.8-flash returned 503 / hung that day; gemini-2.5-flash is closed to new users.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const PROMPT = "Reply with one short sentence: what is a sandbox in payments?";
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 30_000;

const HINTS = {
  400: "Google did not accept the request. If the message mentions the API key, the key is wrong; otherwise the request body or model settings are invalid.",
  401: "Google rejected the key. Check GEMINI_API_KEY in .env has no extra spaces or quotes.",
  403: "The key is not allowed to use the Gemini API. Make sure it was created in Google AI Studio and the API is enabled for its project.",
  404: `The model "${MODEL}" was not found. It may be renamed or shut down; check the Gemini models page.`,
  429: "Free-tier rate limit reached (too many requests per minute or per day). Wait and try again, or check limits in Google AI Studio.",
  500: "Google had an internal problem. Wait a minute and try again.",
  503: "The model is overloaded right now (Google's side, not your key). Wait a minute and try again, or try another model with GEMINI_MODEL.",
};

// Returns an exit code instead of calling process.exit(), which can crash Node on Windows
// while a network connection is still closing.
async function main() {
  console.log(`model: ${MODEL}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("OK: no");
    console.log("Missing in .env: GEMINI_API_KEY");
    console.log("Likely cause: the value is empty in .env, or the script was not run with --env-file=.env.");
    return 1;
  }

  const start = performance.now();
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      // Key goes in a header, not the URL, so it can't leak into logs or error messages.
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }] }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.log("OK: no");
    if (err.name === "TimeoutError") {
      console.log(`Timed out after ${TIMEOUT_MS / 1000}s with no answer.`);
      console.log("Likely cause: the model is overloaded and Google is queueing requests. Try again later or try another model.");
      return 1;
    }
    console.log(`Network error: ${err.cause?.code ?? err.message}`);
    console.log("Likely cause: no internet connection, or a firewall/proxy is blocking generativelanguage.googleapis.com.");
    return 1;
  }

  let body = null;
  try {
    body = await res.json();
  } catch {}
  const seconds = ((performance.now() - start) / 1000).toFixed(2);

  if (!res.ok) {
    console.log("OK: no");
    console.log(`HTTP status: ${res.status}`);
    if (body?.error?.status) console.log(`Google error: ${body.error.status}`);
    if (body?.error?.message) console.log(`Google message: ${body.error.message}`);
    console.log(`Likely cause: ${HINTS[res.status] ?? "Unexpected error. Check the Google message above."}`);
    return 1;
  }

  // Skip "thought" parts (some models return their reasoning separately) and keep the answer text.
  const reply = body?.candidates?.[0]?.content?.parts
    ?.filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join("")
    .trim();

  console.log(`OK: ${reply ? "yes" : "no"}`);
  console.log(`reply: ${reply || `(empty reply, finishReason: ${body?.candidates?.[0]?.finishReason ?? "unknown"})`}`);
  console.log(`time: ${seconds}s`);
  return reply ? 0 : 1;
}

process.exitCode = await main();
