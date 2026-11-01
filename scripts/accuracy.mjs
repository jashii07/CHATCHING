// Step 8: how well does the AI read chats? Scores an AI reply against known answers, field by field
// (buyers, cancellations, items, quantities, dates, unclear flags, pickup/delivery, prices), and lists
// every difference in plain English. The logic is in src/accuracy.js.
//
//   node scripts/accuracy.mjs --cached                          the saved demo reply, no AI call (npm run check)
//   node --env-file-if-exists=.env scripts/accuracy.mjs --live  ONE real parse through the app's AI code
//                                                               (main model; backup if it fails: max 2 calls)
//   ... --chats <file> --expected <file> --date <YYYY-MM-DD>    any chats (default: the demo)
//   ... --reply <file>                                          (--cached) score this saved reply
//   ... --out <file>                                            (--live) where the report goes
//   ... --menu <file>                                           that seller's menu (default: data/menu.json)
//   ... --one-call <seconds>                                    (--live) ONE call to the main model with this long to
//                                                               answer: no retry, no backup, for measuring a long chat
//
// A live run saves its report to tmp/ (git-ignored), or to --out. docs/accuracy.md is written by hand from
// these reports. Holdout chats (data/holdout/) never produce a report in the repo by themselves.
// Exit code: 0 a perfect score, 2 differences, 1 could not score. The key is read from the environment,
// sent in a header (src/gemini.js) and never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveParse, reportMarkdown, savedReplyFor, scoreReply } from "../src/accuracy.js";
import { checkMenu } from "../src/orders.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEMO_CHATS = "data/demo-chats.txt";
const DEMO_EXPECTED = "data/expected-orders.json";
const HOLDOUT = resolve(ROOT, "data/holdout");

const show = (path) => relative(ROOT, resolve(path)).split(sep).join("/");
const now = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} (this computer's time)`;
};

class Stop extends Error {}
const read = (path, what) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Stop(`Could not read the ${what} file ${path}.`);
  }
};
const realDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

function options() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        cached: { type: "boolean" }, live: { type: "boolean" },
        chats: { type: "string" }, expected: { type: "string" }, date: { type: "string" },
        reply: { type: "string" }, out: { type: "string" }, menu: { type: "string" }, "one-call": { type: "string" },
      },
    }));
  } catch (err) {
    throw new Stop(`${err.message}\nUse --cached or --live, with optional --chats, --expected, --date, --reply, --out, --menu, --one-call.`);
  }
  if (values.cached && values.live) throw new Stop("Choose one: --cached (no AI call) or --live (one real call).");
  if (values.live && values.reply) throw new Stop("--reply is for --cached only.");
  const oneCall = values["one-call"];
  if (oneCall !== undefined && !values.live) throw new Stop("--one-call is for --live only.");
  if (oneCall !== undefined && !(/^\d+$/.test(oneCall) && Number(oneCall) >= 30 && Number(oneCall) <= 300)) throw new Stop("--one-call needs whole seconds from 30 to 300.");
  return { ...values, live: Boolean(values.live), oneCallSeconds: oneCall ? Number(oneCall) : null };
}

async function main() {
  const o = options();
  const chats = resolve(o.chats ?? join(ROOT, DEMO_CHATS));
  const expectedPath = resolve(o.expected ?? join(ROOT, DEMO_EXPECTED));
  const isHoldout = chats.startsWith(HOLDOUT + sep);

  const text = read(chats, "chats");
  let expected;
  try {
    expected = JSON.parse(read(expectedPath, "expected answers"));
  } catch (err) {
    throw err instanceof Stop ? err : new Stop(`The expected answers ${show(expectedPath)} are not valid JSON: ${err.message}`);
  }
  if (Array.isArray(expected)) expected = { orders: expected };
  if (!Array.isArray(expected?.orders)) throw new Stop(`The expected answers ${show(expectedPath)} have no "orders" list.`);

  const chatDate = o.date ?? expected.chatDate;
  if (!chatDate) throw new Stop("No chat date: pass --date YYYY-MM-DD (the day the chats were copied).");
  if (!realDate(chatDate)) throw new Stop(`--date must be a real date written YYYY-MM-DD, got "${chatDate}".`);
  if (expected.chatDate && expected.chatDate !== chatDate) console.log(`Note: the expected answers were written for chat date ${expected.chatDate}, not ${chatDate}.`);
  const menuPath = resolve(o.menu ?? join(ROOT, "data/menu.json"));
  let menu;
  try {
    menu = JSON.parse(read(menuPath, "menu"));
  } catch (err) {
    throw err instanceof Stop ? err : new Stop(`The menu ${show(menuPath)} is not valid JSON: ${err.message}`);
  }
  const menuProblems = checkMenu(menu);
  if (menuProblems.length) throw new Stop(`The menu ${show(menuPath)} is not usable: ${menuProblems.join(" ")}`);
  if (isHoldout) console.log("HOLDOUT chats: this is the ONE holdout run (PLAN.md). Record the score as-is; never tune the prompt on it.\n");

  const facts = { date: now(), chats: show(chats), expected: show(expectedPath), chatDate, currency: menu.currency };
  let raw;
  if (o.live) {
    const apiKey = (process.env.GEMINI_API_KEY ?? "").trim();
    if (!apiKey) throw new Stop("GEMINI_API_KEY is missing. Run with: node --env-file-if-exists=.env scripts/accuracy.mjs --live");
    const stamp = Date.now();
    const cacheDir = join(ROOT, `tmp/accuracy-live/${stamp}`); // new and empty: a real call, never a cached answer
    console.log(`LIVE: one batched parse of ${facts.chats} through the app's AI code (${o.oneCallSeconds ? `one call, ${o.oneCallSeconds} s at most` : "main model, backup if it fails"})...`);
    const live = await liveParse({ text, chatDate, menu, apiKey, cacheDir, oneCallSeconds: o.oneCallSeconds });
    console.log(`real calls used: ${live.calls}; ${live.seconds} s`);
    if (live.notice) throw new Stop(`No reply to score: ${live.notice}`);
    raw = live.raw;
    Object.assign(facts, { mode: "live", model: live.model, seconds: live.seconds, calls: live.calls, reply: show(live.replyPath) });
    writeFileSync(live.replyPath.replace(/\.json$/, ".meta.json"), `${JSON.stringify({
      what: "Gemini's raw reply from scripts/accuracy.mjs --live, saved unchanged.",
      model: live.model, savedAt: new Date().toISOString(), chatDate, chats: facts.chats, seconds: live.seconds, calls: live.calls,
    }, null, 2)}\n`);
    console.log(`reply kept (unchanged): ${facts.reply}\n`);
  } else {
    const replyPath = savedReplyFor({ text, chatDate, reply: o.reply ? resolve(o.reply) : null });
    if (!replyPath) throw new Stop(`No saved reply for ${facts.chats} with chat date ${chatDate}. Pass --reply <file>, or run --live once.`);
    raw = read(replyPath, "saved reply");
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(replyPath.replace(/\.json$/, ".meta.json"), "utf8"));
    } catch {}
    Object.assign(facts, { mode: "cached", model: meta.model ?? null, seconds: meta.seconds ?? null, reply: show(replyPath) });
    if (meta.savedAt) facts.date = `${now()}; reply saved ${meta.savedAt}`;
  }

  let result;
  try {
    result = scoreReply({ raw, expected, menu, text, chatDate });
  } catch (err) {
    throw new Stop(`The reply could not be scored: ${err.message}`);
  }
  const md = reportMarkdown(result, facts);
  console.log(md);

  if (o.live) {
    const out = resolve(o.out ?? join(ROOT, `tmp/accuracy-${basename(chats).replace(/\.[^.]*$/, "")}.md`));
    const inTmp = out.startsWith(resolve(ROOT, "tmp") + sep) || out.startsWith(HOLDOUT + sep);
    if (isHoldout && !inTmp) throw new Stop(`Not saved: holdout results stay out of git (tmp/ or data/holdout/), not ${show(out)}.`);
    mkdirSync(resolve(out, ".."), { recursive: true });
    writeFileSync(out, md);
    console.log(`Report saved: ${show(out)}`);
  }
  return result.perfect ? 0 : 2;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (!(err instanceof Stop)) throw err;
  console.log(err.message);
  process.exitCode = 1;
}
