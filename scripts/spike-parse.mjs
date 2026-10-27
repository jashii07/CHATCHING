// Step 3b, the AI reality check: ONE real Gemini call on the demo chats, then a score against the known
// answers (data/expected-orders.json). The raw reply is saved UNCHANGED as data/ai-cache/demo-parse.json,
// so mock mode later returns exactly what Gemini really said, mistakes included.
//
//   node --env-file=.env scripts/spike-parse.mjs --dry-run   build the request and show it, no call
//   node --env-file=.env scripts/spike-parse.mjs             ONE real call (counted), then the score
//   node scripts/spike-parse.mjs --score                     score the saved reply again, no call
//
// Max 3 real calls a day (failed calls count): the count lives in tmp/ai-calls.json and is raised
// BEFORE each call, so a 4th call is refused. The key is read from the environment, sent in a header,
// and never printed. The demo chats are fictional, so they are safe for the free tier.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PARSE_MODEL, parseRequest, replyToOrders } from "../src/ai-prompt.js";
import { scoreParse, structureChecks } from "../src/score-parse.js";
import { groupByBuyer, summary, toRows } from "../src/orders.js";
import { formatMoney } from "../src/money.js";

const MAX_CALLS_PER_DAY = 3;
const TIMEOUT_MS = 90_000; // long on purpose: we want the REAL time, to set the app's timeout from it
const CHAT_DATE = "2026-10-28";
const MODEL = process.env.GEMINI_MODEL || PARSE_MODEL;
const URL_ = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const file = (path) => new URL(`../${path}`, import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(file(path), "utf8"));
const CACHE = "data/ai-cache/demo-parse.json";
const META = "data/ai-cache/demo-parse.meta.json";
const COUNTER = "tmp/ai-calls.json";

const HINTS = {
  400: "Google did not accept the request (often the schema or a setting). The Google message says which part.",
  401: "Google rejected the key. Check GEMINI_API_KEY in .env.",
  403: "The key is not allowed to use the Gemini API.",
  404: `The model "${MODEL}" was not found (renamed or retired?).`,
  429: "Free-tier rate limit reached. Wait, or check the limits in Google AI Studio.",
  500: "Google had an internal problem. Wait a minute.",
  503: "The model is overloaded right now (Google's side).",
};

// The seller's local date, so "3 calls a day" follows the clock on this computer.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function callsToday() {
  try {
    return readJson(COUNTER)[today()] ?? 0;
  } catch {
    return 0;
  }
}

function countOneCall() {
  let counts = {};
  try {
    counts = readJson(COUNTER);
  } catch {}
  counts[today()] = (counts[today()] ?? 0) + 1;
  mkdirSync(file("tmp/"), { recursive: true });
  writeFileSync(file(COUNTER), JSON.stringify(counts, null, 2));
  return counts[today()];
}

function inputs() {
  const menu = readJson("data/menu.json");
  const paste = readFileSync(file("data/demo-chats.txt"), "utf8");
  const { body, messages } = parseRequest({ paste, chatDate: CHAT_DATE, menu });
  // The cache key: same model + same request (prompt, chat date, schema) -> same key (PLAN.md Section 6).
  const inputHash = createHash("sha256").update(`${MODEL}\n${JSON.stringify(body)}`).digest("hex");
  return { menu, body, messages, inputHash };
}

const pad = (text, width) => String(text).padEnd(width);

// Part 2: score the saved reply and run it through our own checks and toRows(). No network.
function scoreSaved() {
  const { menu, messages } = inputs();
  const expected = readJson("data/expected-orders.json");
  const raw = readFileSync(file(CACHE), "utf8");
  console.log(`\nSaved reply: ${CACHE} (${Buffer.byteLength(raw)} bytes)`);

  let aiOrders;
  try {
    aiOrders = replyToOrders(raw);
  } catch (err) {
    console.log(`The reply could not be read as orders: ${err.message}`);
    return 1;
  }
  console.log(`The AI returned ${aiOrders.length} orders: ${aiOrders.map((o) => `${o.buyer} (${o.status})`).join(", ")}`);

  const { scores, differences, perfect } = scoreParse(aiOrders, expected.orders);
  console.log("\nSCORE (against data/expected-orders.json; cancelled orders are scored on status only)");
  console.log(`${pad("what", 15)}score`);
  for (const s of scores) console.log(`${pad(s.name, 15)}${s.ok}/${s.total}${s.ok === s.total ? "" : "   <-- miss"}`);
  console.log(`\nDIFFERENCES (${differences.length}):`);
  for (const d of differences) console.log(`- ${d}`);
  if (!differences.length) console.log("- none: a perfect score.");

  console.log("\nOUR CHECKS ON THE REPLY (message numbers, dates 0-14 days after the message, note length):");
  const problems = structureChecks(aiOrders, messages);
  for (const p of problems) console.log(`- ${p}`);
  if (!problems.length) console.log("- all fine.");

  console.log("\nTHROUGH toRows() (prices from the menu, unclear rows kept):");
  let rows;
  try {
    rows = toRows(aiOrders, menu);
  } catch (err) {
    console.log(`CRASH: ${err.message}`);
    return 1;
  }
  console.log(`- no crash: ${rows.length} rows (one per item)`);
  for (const group of groupByBuyer(rows)) {
    const want = expected.orders.find((o) => o.buyer.toLowerCase() === group.buyer.trim().toLowerCase());
    const total = group.total == null ? "needs a check" : formatMoney(group.total, menu.currency);
    const wantTotal = want?.total == null ? "needs a check" : formatMoney(want.total, menu.currency);
    console.log(`  ${pad(group.buyer, 10)} ${pad(total, 14)} expected ${wantTotal}${total === wantTotal ? "" : "   <-- differs"}`);
  }
  for (const row of rows.filter((r) => r.unclear)) console.log(`  unclear row: ${row.buyer}: ${row.reason}`);
  const s = summary(rows);
  console.log(`- TOTALS: ${s.ready} orders ready to invoice, ${formatMoney(s.expected, menu.currency)} expected; ${s.needsCheck} need a check (answers: ${expected.summary.clearOrders} orders, ${formatMoney(expected.summary.clearTotal, menu.currency)})`);
  return perfect ? 0 : 2;
}

async function realCall() {
  const apiKey = (process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.log("GEMINI_API_KEY is missing. Run with: node --env-file=.env scripts/spike-parse.mjs");
    return 1;
  }
  const used = callsToday();
  if (used >= MAX_CALLS_PER_DAY) {
    console.log(`Refused: ${used} of ${MAX_CALLS_PER_DAY} real calls already used today (${COUNTER}). No call made.`);
    return 1;
  }
  const { body, inputHash } = inputs();
  const n = countOneCall(); // counted BEFORE the call: a failed call still counts
  console.log(`model: ${MODEL}; chat date ${CHAT_DATE}; real call ${n} of ${MAX_CALLS_PER_DAY} today; timeout ${TIMEOUT_MS / 1000} s`);

  const start = performance.now();
  let res;
  let text;
  try {
    res = await fetch(URL_, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" }, // key in a header, never in the URL
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    console.log(err.name === "TimeoutError" ? `TIMED OUT after ${seconds} s with no answer.` : `Network error after ${seconds} s: ${err.cause?.code ?? err.message}`);
    return 1;
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(`time: ${seconds.toFixed(1)} s (HTTP ${res.status})`);

  if (!res.ok) {
    let error = {};
    try {
      error = JSON.parse(text).error ?? {};
    } catch {}
    mkdirSync(file("tmp/"), { recursive: true });
    writeFileSync(file(`tmp/spike-error-${Date.now()}.json`), text);
    console.log(`Google error: ${error.status ?? "?"}: ${error.message ?? text.slice(0, 300)}`);
    console.log(`Likely cause: ${HINTS[res.status] ?? "see the Google message above."}`);
    return 1;
  }

  // Save the reply byte for byte. A reply from an earlier call is kept in tmp/, not lost.
  mkdirSync(file("data/ai-cache/"), { recursive: true });
  if (existsSync(file(CACHE))) renameSync(file(CACHE), file(`tmp/demo-parse-before-${Date.now()}.json`));
  writeFileSync(file(CACHE), text);
  let reply = {};
  try {
    reply = JSON.parse(text);
  } catch {}
  writeFileSync(file(META), `${JSON.stringify({
    what: "Gemini's raw generateContent reply for data/demo-chats.txt, saved unchanged in demo-parse.json (Step 3b).",
    model: MODEL,
    modelVersion: reply.modelVersion ?? null,
    savedAt: new Date().toISOString(),
    chatDate: CHAT_DATE,
    inputHash,
    seconds: Number(seconds.toFixed(1)),
    replyBytes: Buffer.byteLength(text),
    usage: reply.usageMetadata ?? null,
    finishReason: reply.candidates?.[0]?.finishReason ?? null,
  }, null, 2)}\n`);
  console.log(`saved: ${CACHE} (${Buffer.byteLength(text)} bytes, unchanged) + ${META}`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--dry-run")) {
    const { body, messages, inputHash } = inputs();
    const prompt = body.contents[0].parts[0].text;
    mkdirSync(file("tmp/"), { recursive: true });
    writeFileSync(file("tmp/spike-prompt.txt"), prompt);
    writeFileSync(file("tmp/spike-request.json"), JSON.stringify(body, null, 2));
    console.log(`DRY RUN (no call). model ${MODEL}; ${messages.length} messages; prompt ${prompt.length} characters; request ${JSON.stringify(body).length} bytes`);
    console.log(`input hash ${inputHash.slice(0, 16)}...; real calls used today: ${callsToday()} of ${MAX_CALLS_PER_DAY}`);
    console.log("written: tmp/spike-prompt.txt, tmp/spike-request.json\n");
    console.log(prompt);
    return 0;
  }
  if (args.includes("--score")) return scoreSaved();
  const code = await realCall();
  return code === 0 ? scoreSaved() : code;
}

process.exitCode = await main();
