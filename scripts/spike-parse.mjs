// Step 3b, the AI reality check (reused in Step 7 for the messier demo chats): ONE real Gemini call on the
// demo chats, then a score against the known answers (data/expected-orders.json). The raw reply is saved
// UNCHANGED, so mock mode returns exactly what Gemini really said, mistakes included.
//
//   node --env-file-if-exists=.env scripts/spike-parse.mjs --dry-run   build the request and show it, no call
//   node --env-file-if-exists=.env scripts/spike-parse.mjs             ONE real call (counted), then the score
//   node scripts/spike-parse.mjs --score [file]                        score a saved reply again, no call
//   node scripts/spike-parse.mjs --use <file>                          make that saved reply the demo reply
//
// Step 7: on 503/429 it waits and asks the main model once more, then the backup model (every try is a
// counted call). Each successful reply is kept in tmp/demo-parse-<time>.json; it becomes the demo reply
// (data/ai-cache/demo-parse.json) only if it scores perfectly, or when chosen with --use.
// Max 6 real calls a day (Jasper's Step 7 limit; failed calls count): the count lives in tmp/ai-calls.json
// and is raised BEFORE each call, so a 7th call is refused. The key is read from the environment, sent in
// a header (src/gemini.js), and never printed. The demo chats are fictional, so they are safe for the free tier.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseRequest, replyToOrders } from "../src/ai-prompt.js";
import { BACKUP_MODEL, GeminiError, MAIN_MODEL, callGemini } from "../src/gemini.js";
import { scoreParse, structureChecks } from "../src/score-parse.js";
import { groupByBuyer, summary, toRows } from "../src/orders.js";
import { formatMoney } from "../src/money.js";

const MAX_CALLS_PER_DAY = 6;
const TIMEOUT_MS = 90_000; // long on purpose: we want the REAL time, to check the app's 45 s timeout
const RETRY_WAIT_MS = 20_000; // after a 503/429, wait before asking the main model once more
const CHAT_DATE = "2026-10-28";
const MODEL = process.env.GEMINI_MODEL || MAIN_MODEL;

const file = (path) => new URL(`../${path}`, import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(file(path), "utf8"));
const CACHE = "data/ai-cache/demo-parse.json";
const META = "data/ai-cache/demo-parse.meta.json";
const COUNTER = "tmp/ai-calls.json";

const HINTS = {
  400: "Google did not accept the request (often the schema or a setting). The Google message says which part.",
  401: "Google rejected the key. Check GEMINI_API_KEY in .env.",
  403: "The key is not allowed to use the Gemini API.",
  404: "The model was not found (renamed or retired?).",
  429: "Free-tier rate limit reached. Wait, or check the limits in Google AI Studio.",
  500: "Google had an internal problem. Wait a minute.",
  503: "The model is overloaded right now (Google's side).",
};

// The seller's local date, so "6 calls a day" follows the clock on this computer.
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
  // A fingerprint of the exact request (prompt, chat date, schema), kept in the meta file.
  const inputHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { menu, body, messages, inputHash };
}

const pad = (text, width) => String(text).padEnd(width);

// Score a saved reply and run it through our own checks and toRows(). No network.
// -> { code: 0 perfect, 2 differences, 1 unreadable; differences: count }
function scoreSaved(path = CACHE) {
  const { menu, messages } = inputs();
  const expected = readJson("data/expected-orders.json");
  const raw = readFileSync(file(path), "utf8");
  console.log(`\nSaved reply: ${path} (${Buffer.byteLength(raw)} bytes)`);

  let aiOrders;
  try {
    aiOrders = replyToOrders(raw);
  } catch (err) {
    console.log(`The reply could not be read as orders: ${err.message}`);
    return { code: 1, differences: Infinity };
  }
  console.log(`The AI returned ${aiOrders.length} orders: ${aiOrders.map((o) => `${o.buyer} (${o.status})`).join(", ")}`);

  const { scores, differences, perfect } = scoreParse(aiOrders, expected.orders, { currency: menu.currency });
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

  console.log("\nTHROUGH toRows() (prices from the menu, price checks, unclear rows kept):");
  let rows;
  try {
    rows = toRows(aiOrders, menu);
  } catch (err) {
    console.log(`CRASH: ${err.message}`);
    return { code: 1, differences: Infinity };
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
  return { code: perfect ? 0 : 2, differences: differences.length };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One counted call. -> { text, model, seconds } or null (failed; the reason is printed).
async function oneCall(apiKey, model, body) {
  if (callsToday() >= MAX_CALLS_PER_DAY) {
    console.log(`Refused: ${callsToday()} of ${MAX_CALLS_PER_DAY} real calls already used today (${COUNTER}). No call made.`);
    return { refused: true };
  }
  const n = countOneCall(); // counted BEFORE the call: a failed call still counts
  console.log(`model: ${model}; chat date ${CHAT_DATE}; real call ${n} of ${MAX_CALLS_PER_DAY} today; timeout ${TIMEOUT_MS / 1000} s`);
  try {
    const reply = await callGemini({ apiKey, model, body, timeoutMs: TIMEOUT_MS });
    console.log(`time: ${reply.seconds} s (HTTP 200)`);
    return reply;
  } catch (err) {
    if (!(err instanceof GeminiError)) throw err;
    console.log(`FAILED after ${err.seconds} s: ${err.message}`);
    if (HINTS[err.status]) console.log(`Likely cause: ${HINTS[err.status]}`);
    return { error: err };
  }
}

// The main model; on 503/429 wait and try it once more; then the backup model.
async function realCall() {
  const apiKey = (process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.log("GEMINI_API_KEY is missing. Run with: node --env-file-if-exists=.env scripts/spike-parse.mjs");
    return null;
  }
  const { body } = inputs();
  let reply = await oneCall(apiKey, MODEL, body);
  if (reply.error && [429, 503].includes(reply.error.status)) {
    console.log(`Waiting ${RETRY_WAIT_MS / 1000} s, then asking ${MODEL} once more...`);
    await sleep(RETRY_WAIT_MS);
    reply = await oneCall(apiKey, MODEL, body);
  }
  if (reply.error?.retryable && MODEL !== BACKUP_MODEL) {
    console.log(`Trying the backup model ${BACKUP_MODEL}...`);
    reply = await oneCall(apiKey, BACKUP_MODEL, body);
  }
  return reply.text ? reply : null;
}

// Keep the reply in tmp/ (never lost), with its facts next to it.
function keep(reply) {
  const { inputHash } = inputs();
  let parsed = {};
  try {
    parsed = JSON.parse(reply.text);
  } catch {}
  const stamp = Date.now();
  const path = `tmp/demo-parse-${stamp}.json`;
  mkdirSync(file("tmp/"), { recursive: true });
  writeFileSync(file(path), reply.text);
  writeFileSync(file(`tmp/demo-parse-${stamp}.meta.json`), `${JSON.stringify({
    what: "Gemini's raw generateContent reply for data/demo-chats.txt, saved unchanged in demo-parse.json (Step 3b; new chats in Step 7).",
    model: reply.model,
    modelVersion: parsed.modelVersion ?? null,
    savedAt: new Date().toISOString(),
    chatDate: CHAT_DATE,
    inputHash,
    seconds: reply.seconds,
    replyBytes: Buffer.byteLength(reply.text),
    usage: parsed.usageMetadata ?? null,
    finishReason: parsed.candidates?.[0]?.finishReason ?? null,
  }, null, 2)}\n`);
  console.log(`kept: ${path} (${Buffer.byteLength(reply.text)} bytes, unchanged) + its .meta.json`);
  return path;
}

// Make a kept reply the demo reply (byte for byte), with its meta file.
function use(path) {
  copyFileSync(file(path), file(CACHE));
  copyFileSync(file(path.replace(/\.json$/, ".meta.json")), file(META));
  console.log(`\nThe demo reply is now ${path} -> ${CACHE} (+ ${META}).`);
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
  if (args.includes("--score")) return scoreSaved(args[args.indexOf("--score") + 1] ?? CACHE).code;
  if (args.includes("--use")) {
    use(args[args.indexOf("--use") + 1]);
    return scoreSaved().code;
  }
  const reply = await realCall();
  if (!reply) return 1;
  const path = keep(reply);
  const { code } = scoreSaved(path);
  if (code === 0) use(path);
  else console.log(`\nNot made the demo reply (not a perfect score). Choose one with --use <file>.`);
  return code;
}

process.exitCode = await main();
