// Tests for the accuracy check (src/accuracy.js + scripts/accuracy.mjs, Step 8). No network: the fixture
// replies in test/fixtures/accuracy/ are made from data/expected-orders.json with one mistake each, and
// the "live" tests use a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveParse, reportMarkdown, savedReplyFor, scoreReply } from "../src/accuracy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const MENU = readJson("data/menu.json");
const EXPECTED = readJson("data/expected-orders.json");
const CHATS = readFileSync(join(root, "data/demo-chats.txt"), "utf8");
const fixture = (name) => readFileSync(join(root, `test/fixtures/accuracy/${name}.json`), "utf8");
const score = (name) => scoreReply({ raw: fixture(name), expected: EXPECTED, menu: MENU, text: CHATS, chatDate: EXPECTED.chatDate });
const line = (s) => `${s.label} ${s.ok}/${s.total}`;

test("accuracy: a perfect reply scores full marks on every field, with the answer key's totals", () => {
  const result = score("perfect");
  assert.equal(result.perfect, true);
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.scores.map(line), [
    "buyers 10/10", "cancellations 10/10", "items 9/9", "quantities 9/9", "dates 9/9",
    "unclear flags 9/9", "pickup/delivery 9/9", "prices 9/9",
  ]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.totals, { ready: 7, total: "366.00", needsCheck: 2 });
});

test("accuracy: a wrong quantity is named in plain English with the menu's item name", () => {
  const result = score("wrong-qty");
  assert.equal(result.perfect, false);
  assert.deepEqual(result.differences, ["Jun Wei: expected 2 x Cheese brownies, AI said 1."]);
  assert.equal(line(result.scores.find((s) => s.name === "qty")), "quantities 8/9");
});

test("accuracy: a missing buyer is named and costs a point in buyers", () => {
  const result = score("missing-buyer");
  assert.deepEqual(result.differences, ["Priya: expected an active order, the AI missed this buyer."]);
  assert.equal(line(result.scores[0]), "buyers 9/10");
});

test("accuracy: a missed cancellation is named", () => {
  const result = score("wrong-cancellation");
  assert.deepEqual(result.differences, ["Danish: expected cancelled, AI said active."]);
  assert.equal(line(result.scores.find((s) => s.name === "cancellations")), "cancellations 9/10");
});

test("accuracy: an unreadable reply is a clear error, never a score", () => {
  assert.throws(() => scoreReply({ raw: "{}", expected: EXPECTED, menu: MENU, text: CHATS, chatDate: EXPECTED.chatDate }), /no text/);
});

test("accuracy: the demo chats find the saved demo reply; unknown chats find none", () => {
  assert.match(savedReplyFor({ text: CHATS, chatDate: EXPECTED.chatDate }), /demo-parse\.json$/);
  assert.equal(savedReplyFor({ text: CHATS, chatDate: "2026-10-29" }), null); // another day is another question
  assert.equal(savedReplyFor({ text: CHATS, chatDate: "2026-10-28", reply: "x.json" }), "x.json");
});

test("accuracy: the report has the date, model, seconds, scores and every difference", () => {
  const result = score("wrong-qty");
  const md = reportMarkdown(result, {
    date: "2026-10-29 21:00", mode: "live", model: "gemini-3.6-flash", seconds: 18.2, calls: 1,
    chats: "data/demo-chats.txt", expected: "data/expected-orders.json", chatDate: "2026-10-28", messages: 18,
  });
  for (const part of ["2026-10-29 21:00", "gemini-3.6-flash", "18.2 s", "| quantities | 8/9 |", "- Jun Wei: expected 2 x Cheese brownies, AI said 1.", "1 real call"]) {
    assert.ok(md.includes(part), `report is missing: ${part}`);
  }
});

// A fake Gemini: answers each call with the next status in the list (200 = the perfect fixture).
function fakeGemini(statuses) {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url.match(/models\/([^:]+):/)[1]);
    const status = statuses.shift();
    if (status === 200) return new Response(fixture("perfect"), { status: 200 });
    return new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "overloaded" } }), { status });
  };
  return { fetch, seen };
}

test("accuracy --live: ONE call through the app's AI code, never the saved demo reply", async () => {
  const { fetch, seen } = fakeGemini([200]);
  const cacheDir = mkdtempSync(join(tmpdir(), "acc-"));
  const live = await liveParse({ text: CHATS, chatDate: EXPECTED.chatDate, menu: MENU, apiKey: "test-key", cacheDir, fetch, log: () => {} });
  assert.equal(live.calls, 1);
  assert.deepEqual(seen, ["gemini-3.6-flash"]);
  assert.equal(live.model, "gemini-3.6-flash");
  assert.equal(live.raw, fixture("perfect")); // the reply, byte for byte
  assert.ok(existsSync(live.replyPath));
  assert.equal(typeof live.seconds, "number");
});

test("accuracy --live: the backup model answers when the main one is overloaded (2 calls)", async () => {
  const { fetch, seen } = fakeGemini([503, 200]);
  const live = await liveParse({ text: CHATS, chatDate: EXPECTED.chatDate, menu: MENU, apiKey: "test-key", cacheDir: mkdtempSync(join(tmpdir(), "acc-")), fetch, log: () => {} });
  assert.deepEqual(seen, ["gemini-3.6-flash", "gemini-3.8-flash"]);
  assert.equal(live.calls, 2);
  assert.equal(live.model, "gemini-3.8-flash");
});

test("accuracy --live: both models busy gives a notice, no score", async () => {
  const { fetch } = fakeGemini([503, 503]);
  const live = await liveParse({ text: CHATS, chatDate: EXPECTED.chatDate, menu: MENU, apiKey: "test-key", cacheDir: mkdtempSync(join(tmpdir(), "acc-")), fetch, log: () => {} });
  assert.equal(live.calls, 2);
  assert.match(live.notice, /busy/);
  assert.equal(live.raw, undefined);
});

// The command line, as npm run check and Jasper run it. No key in its environment, so no real call.
function run(...args) {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  return spawnSync(process.execPath, ["scripts/accuracy.mjs", ...args], { cwd: root, encoding: "utf8", env });
}

test("accuracy.mjs --cached: the saved demo reply scores perfectly and writes no report", () => {
  const report = join(root, "docs/accuracy.md");
  const before = existsSync(report) ? statSync(report).mtimeMs : null;
  const out = run("--cached");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\| buyers \| 10\/10 \|/);
  assert.match(out.stdout, /none: a perfect score/);
  assert.equal(existsSync(report) ? statSync(report).mtimeMs : null, before);
});

test("accuracy.mjs: any chat file with --chats --expected --date --reply; a difference exits with 2", () => {
  const out = run("--cached", "--chats", "data/demo-chats.txt", "--expected", "data/expected-orders.json",
    "--date", "2026-10-28", "--reply", "test/fixtures/accuracy/wrong-qty.json");
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stdout, /- Jun Wei: expected 2 x Cheese brownies, AI said 1\./);
});

test("accuracy.mjs: clear errors for no saved reply, a missing key, bad options", () => {
  const noReply = run("--cached", "--date", "2025-01-01");
  assert.equal(noReply.status, 1);
  assert.match(noReply.stdout + noReply.stderr, /No saved reply/);
  const noKey = run("--live");
  assert.equal(noKey.status, 1);
  assert.match(noKey.stdout + noKey.stderr, /GEMINI_API_KEY is missing/);
  const both = run("--cached", "--live");
  assert.equal(both.status, 1);
  const badDate = run("--cached", "--date", "28/10/2026");
  assert.equal(badDate.status, 1);
  assert.match(badDate.stdout + badDate.stderr, /YYYY-MM-DD/);
});
