// The accuracy check (Step 8, PLAN.md Section 7): score an AI reply against known answers, field by
// field, with every difference in plain English. Used by scripts/accuracy.mjs.
// - The scoring is src/score-parse.js (the same scorer as the Step 3b spike, not a second one).
// - A live run goes through the app's own AI code (createAi in src/ai.js: main model, then the backup),
//   with an empty cache folder so it really asks Gemini and never answers from the saved demo reply.
// The key is passed in, sent in a header by src/gemini.js, and never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_CACHE, createAi, demoReplies, parseKey } from "./ai.js";
import { MAIN_MODEL } from "./gemini.js";
import { buildParsePrompt, replyToOrders } from "./ai-prompt.js";
import { formatMoney } from "./money.js";
import { summary, toRows } from "./orders.js";
import { scoreParse, structureChecks } from "./score-parse.js";
import { checkOrders, sellerOrders } from "./validate.js";

// A raw Gemini reply + the expected answers ({ orders, summary? }) -> the score, our own checks on the
// reply, and the totals the app would show. Scored after our own checks (checkOrders), because that is what
// the seller would see. Throws if the reply can't be read as orders.
export function scoreReply({ raw, expected, menu, text, chatDate }) {
  const replied = replyToOrders(raw);
  const { messages } = buildParsePrompt({ paste: text, chatDate, menu });
  const orders = checkOrders(replied, messages, menu);
  const { scores, differences, perfect } = scoreParse(orders, expected.orders, { menu });
  const s = summary(toRows(orders, menu));
  return {
    orders, scores, differences, perfect, messages: messages.length,
    problems: [
      ...structureChecks(replied, messages),
      ...sellerOrders(replied, messages, menu).map((order) => `${order.buyer}: removed, this order came only from the seller's messages.`),
    ],
    totals: { ready: s.ready, total: s.expected, needsCheck: s.needsCheck },
    want: expected.summary ?? null,
  };
}

// The saved reply for these chats: the one asked for, else the demo reply that ships with the app,
// else the app's own cache of earlier real replies (data/runtime/ai-cache/). null if there is none.
export function savedReplyFor({ text, chatDate, reply = null }) {
  if (reply) return reply;
  const key = parseKey(text, chatDate);
  const demo = demoReplies().get(key);
  if (demo) return demo;
  const cached = join(RUNTIME_CACHE, `parse-${key}.json`);
  return existsSync(cached) ? cached : null;
}

// ONE batched parse through the app's AI code. cacheDir must be a new, empty folder: the raw reply is
// saved there (byte for byte) and read back. -> { raw, model, seconds, calls, replyPath } or
// { notice, seconds, calls } when no model answered. seconds = the whole wait, backup included.
// At most 2 calls (main, then backup; no retry of the same model), each one counted in the app's daily
// counter (src/usage.js) like any real call. The tests pass their own counter, clock and wait in "ai".
// oneCallSeconds: ONE call to the main model with this many seconds, for measuring a long chat: no retry, no
// backup, so a "high demand" answer stops the run at once.
export async function liveParse({ text, chatDate, menu, apiKey, cacheDir, oneCallSeconds = null, fetch = globalThis.fetch, log = console.log, ai: aiOptions = {} }) {
  let calls = 0;
  const counted = (...args) => {
    calls += 1;
    return fetch(...args);
  };
  const limits = oneCallSeconds ? { models: [MAIN_MODEL], maxCalls: 1, budgetMs: oneCallSeconds * 1000 } : { maxCalls: 2 };
  const ai = createAi({ mode: "real", apiKey, replies: new Map(), cacheDir, fetch: counted, log, ...limits, ...aiOptions });
  const start = performance.now();
  const result = await ai.parse({ text, chatDate, menu });
  const seconds = Number(((performance.now() - start) / 1000).toFixed(1));
  if (result.notice) return { notice: result.notice, seconds, calls };
  const replyPath = join(cacheDir, `parse-${parseKey(text, chatDate)}.json`);
  return { raw: readFileSync(replyPath, "utf8"), model: result.from, seconds, calls, replyPath };
}

const money = (amount, currency) => (amount == null ? "?" : currency ? formatMoney(amount, currency).replace(/\s/g, " ") : amount);

// The result as Markdown: printed by the script, and saved to tmp/ after a live run.
// facts: { date, mode, model, seconds, calls, chats, expected, chatDate, messages, reply, currency }
export function reportMarkdown(result, facts) {
  const ok = result.scores.reduce((n, s) => n + s.ok, 0);
  const total = result.scores.reduce((n, s) => n + s.total, 0);
  const how = facts.mode === "live"
    ? `live: ${facts.calls} real call${facts.calls === 1 ? "" : "s"} through the app's AI code`
    : `cached: the saved reply${facts.reply ? ` \`${facts.reply}\`` : ""}, no AI call`;
  const t = result.totals;
  const lines = [
    "# Accuracy check",
    "",
    `- **Date:** ${facts.date}`,
    `- **Chats:** \`${facts.chats}\` (${facts.messages ?? result.messages} messages), chat date ${facts.chatDate}`,
    `- **Expected answers:** \`${facts.expected}\``,
    `- **Mode:** ${how}`,
    `- **Model:** ${facts.model ?? "not recorded"}`,
    `- **Time:** ${facts.seconds == null ? "not recorded" : `${facts.seconds} s`}`,
    `- **Result:** ${result.perfect ? "a perfect score" : `${result.differences.length} difference${result.differences.length === 1 ? "" : "s"}`} (${ok}/${total} checks right)`,
    "",
    "| What | Score |",
    "|---|---|",
    ...result.scores.map((s) => `| ${s.label} | ${s.ok}/${s.total} |`),
    "",
    "Cancelled orders are scored on their status only.",
    "",
    `## Differences (${result.differences.length})`,
    "",
    ...(result.differences.length ? result.differences.map((d) => `- ${d}`) : ["- none: a perfect score."]),
    "",
    "## Our own checks on the reply (message numbers, dates 0-14 days after the message, note length)",
    "",
    ...(result.problems.length ? result.problems.map((p) => `- ${p}`) : ["- all fine."]),
    "",
    "## Totals the app would show (prices from the menu)",
    "",
    `- AI reply: ${t.ready} orders ready to invoice, ${money(t.total, facts.currency)}; ${t.needsCheck} need a check.`,
    ...(result.want ? [`- Expected: ${result.want.clearOrders} orders ready to invoice, ${money(result.want.clearTotal, facts.currency)}; ${result.want.needsCheck} need a check.`] : []),
    "",
  ];
  return lines.join("\n");
}
