// Tests for the app's REAL AI mode (Steps 7 and 9, src/ai.js + src/gemini.js + src/usage.js). Gemini is a
// FAKE fetch here, and the clock, the timer and the wait are fake too: npm run check never calls the real
// AI, never needs a key, and never sleeps (a "35 s timeout" passes in a millisecond).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, parseKey, usedUp, NO_KEY, AI_BUSY, AI_REFUSED } from "../src/ai.js";
import { MAIN_MODEL, BACKUP_MODEL } from "../src/gemini.js";
import { createUsage } from "../src/usage.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const CHATS = "[29/10 9:00 AM] Zara: 2 jars of cookies for saturday pls";
const CHAT_DATE = "2026-10-29";
const ORDERS = [{ buyer: "Zara", status: "active", sourceMsgs: [1], items: [{ itemId: "cookies", qty: 2 }], deliveryDate: "2026-10-31", fulfilment: null, unclear: false, reason: "", note: "" }];
const reply = (orders = ORDERS) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ orders }) }] }, finishReason: "STOP" }] });
const NOON_MYT = Date.UTC(2026, 9, 30, 4, 0); // Fri 30 Oct 2026, 12:00 Malaysia time = Thu 29 Oct 21:00 Pacific
const S = 1000;

// A fake clock + timer + wait. The fake timer remembers the timeout of the call just started.
function fakeTime(start = NOON_MYT) {
  const time = { t: start, timeouts: [], waits: [] };
  time.now = () => time.t;
  time.sleep = async (ms) => (time.waits.push(ms), (time.t += ms));
  time.timeoutSignal = (ms) => (time.timeouts.push(ms), new AbortController().signal);
  return time;
}

// A fake Gemini: answers[i] is used for call i: "ok", "broken", "network", "hang" (no answer before the
// timeout), a status number, or [answer, seconds it takes]. An answer slower than the call's timeout is a
// hang, like the real timer would make it; a hang moves the fake clock by the whole timeout.
function fakeGemini(time, ...answers) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), at: time.t });
    const [answer, seconds = 1] = [answers[calls.length - 1] ?? "ok"].flat();
    if (answer === "network") throw new TypeError("fetch failed");
    if (answer === "hang" || seconds * S > time.timeouts.at(-1)) {
      time.t += time.timeouts.at(-1);
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    time.t += seconds * S;
    if (answer === "ok") return new Response(reply(), { status: 200 });
    if (answer === "broken") return new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: answer, status: "UNAVAILABLE", message: "busy" } }), { status: answer });
  }
  return { fetch, calls, models: () => calls.map((c) => c.url.match(/models\/(.+):generateContent/)[1]) };
}

const tempDir = () => mkdtempSync(join(tmpdir(), "chatching-ai-"));
const make = (answers, extra = {}) => {
  const time = extra.time ?? fakeTime();
  const gemini = fakeGemini(time, ...answers);
  const dir = tempDir();
  const cacheDir = join(dir, "ai-cache");
  const usageFile = join(dir, "ai-usage.json");
  const logs = [];
  const stages = [];
  const usage = extra.usage ?? createUsage({ file: usageFile, models: [MAIN_MODEL, BACKUP_MODEL], now: time.now, log: () => {} });
  const ai = createAi({
    mode: "real", apiKey: "fake-key-123", fetch: gemini.fetch, cacheDir, usage,
    now: time.now, sleep: time.sleep, timeoutSignal: time.timeoutSignal, log: (line) => logs.push(line), ...extra,
  });
  const start = time.t;
  return {
    ai, gemini, time, cacheDir, usage, usageFile, logs, stages,
    seconds: () => (time.t - start) / S,
    parse: (text = CHATS) => ai.parse({ text, chatDate: CHAT_DATE, menu, onStage: (stage) => stages.push(stage) }),
  };
};

test("the demo chats are answered from the saved reply: 0 calls, even in real mode", async () => {
  const { ai, gemini } = make([]);
  const result = await ai.parse({ text: DEMO, chatDate: "2026-10-28", menu });
  assert.equal(result.from, "saved");
  assert.ok(result.orders.length > 0);
  assert.equal(gemini.calls.length, 0);
});

test("no key -> a friendly notice, no call, nothing counted", async () => {
  const { parse, gemini, ai } = make([], { apiKey: "" });
  assert.deepEqual(await parse(), { notice: NO_KEY });
  assert.equal(gemini.calls.length, 0);
  assert.equal(ai.callsLeft(), 40);
});

test("main model OK: one batched call, key in a header (never the URL), reply cached, 1 call counted", async () => {
  const { parse, gemini, cacheDir, logs, ai, stages, time } = make(["ok"]);
  const first = await parse();
  assert.deepEqual([first.from, first.orders], [MAIN_MODEL, ORDERS]);
  assert.equal(gemini.calls.length, 1);
  assert.equal(gemini.calls[0].headers["x-goog-api-key"], "fake-key-123");
  assert.doesNotMatch(gemini.calls[0].url, /fake-key|key=/);
  assert.ok(gemini.calls[0].body.contents[0].parts[0].text.includes("Zara: 2 jars of cookies"));
  assert.ok(gemini.calls[0].body.generationConfig.responseSchema.properties.orders);
  assert.equal(readFileSync(join(cacheDir, `parse-${parseKey(CHATS, CHAT_DATE)}.json`), "utf8"), reply()); // byte for byte
  assert.ok(logs.every((line) => !line.includes("fake-key")));
  assert.deepEqual(time.timeouts, [35 * S]); // the main model's share of the 60 s
  assert.deepEqual(stages, []); // no "trying the backup"
  assert.equal(ai.callsLeft(), 39);

  const again = await parse(`  ${CHATS}  \r\n\r\n`); // same chats, other spaces and line endings
  assert.equal(again.from, "cache");
  assert.equal(gemini.calls.length, 1); // no second call, nothing more counted
  assert.equal(ai.callsLeft(), 39);
});

test("main 503 that comes back fast -> wait 2 s, ask the main model again once, it answers", async () => {
  const { parse, gemini, time, stages } = make([[503, 3.8], "ok"]);
  assert.equal((await parse()).from, MAIN_MODEL);
  assert.deepEqual(gemini.models(), [MAIN_MODEL, MAIN_MODEL]);
  assert.deepEqual(time.waits, [2 * S]);
  assert.deepEqual(time.timeouts, [35 * S, 29.2 * S]); // the retry only gets what is left of the 35 s
  assert.deepEqual(stages, []);
});

test("main 503 -> retry 503 -> the backup answers: 3 calls, the page is told about the backup", async () => {
  for (const status of [503, 429]) {
    const { parse, gemini, stages, ai } = make([status, status, "ok"]);
    const result = await parse();
    assert.deepEqual(gemini.models(), [MAIN_MODEL, MAIN_MODEL, BACKUP_MODEL], String(status));
    assert.equal(result.from, BACKUP_MODEL);
    assert.deepEqual(stages, ["backup"]);
    assert.equal(ai.callsLeft(), 37); // every attempt counted, failed ones too
  }
});

test("main 503 after 20 s -> no retry (a real read wouldn't fit), straight to the backup", async () => {
  const { parse, gemini, time } = make([[503, 20], "ok"]);
  assert.equal((await parse()).from, BACKUP_MODEL);
  assert.deepEqual(gemini.models(), [MAIN_MODEL, BACKUP_MODEL]);
  assert.deepEqual(time.waits, []);
  assert.deepEqual(time.timeouts, [35 * S, 40 * S]); // the backup gets everything left of the 60 s
});

test("main model too slow -> it is cut off at 35 s and the backup gets the last 25 s (never the same model again)", async () => {
  const { parse, gemini, logs, time, stages, seconds } = make(["hang", ["ok", 18]]);
  assert.equal((await parse()).from, BACKUP_MODEL);
  assert.deepEqual(gemini.models(), [MAIN_MODEL, BACKUP_MODEL]);
  assert.deepEqual(time.timeouts, [35 * S, 25 * S]);
  assert.deepEqual(stages, ["backup"]);
  assert.ok(logs.some((line) => /No answer within 35 s/.test(line)));
  assert.equal(seconds(), 53);
});

test("both models fail -> the friendly \"AI busy\" notice within 60 s, never more than 3 calls, nothing cached", async () => {
  const cases = [
    { answers: [503, 503, 503], calls: 3 }, // fast 503s: main, main again, backup
    { answers: ["hang", "hang"], calls: 2 }, // both too slow: 35 s + 25 s
    { answers: [[503, 43], [503, 4.3]], calls: 2 }, // 29 Oct, now cut off at 35 s
    { answers: ["hang", 503, 503], calls: 3 }, // backup busy fast: 24 s left, so one retry still fits
    { answers: ["hang", [503, 5]], calls: 2 }, // backup busy after 5 s: 20 s left, a retry wouldn't fit
  ];
  for (const { answers, calls } of cases) {
    const { parse, gemini, cacheDir, seconds } = make(answers);
    assert.deepEqual(await parse(), { notice: AI_BUSY }, JSON.stringify(answers));
    assert.equal(gemini.calls.length, calls, JSON.stringify(answers));
    assert.ok(seconds() <= 60, `${JSON.stringify(answers)}: ${seconds()} s`);
    assert.ok(!existsSync(cacheDir) || readdirSync(cacheDir).length === 0);
  }
  assert.equal(AI_BUSY, "The AI is busy right now. Please try again in a minute, or click Load demo to see how it works.");
});

test("a request Google refuses (400) is not retried and not sent to the backup", async () => {
  const { parse, gemini } = make([400]);
  assert.deepEqual(await parse(), { notice: AI_REFUSED });
  assert.equal(gemini.calls.length, 1);
});

test("a network error goes to the backup without waiting", async () => {
  const { parse, gemini, time } = make(["network", "ok"]);
  assert.equal((await parse()).from, BACKUP_MODEL);
  assert.deepEqual(gemini.models(), [MAIN_MODEL, BACKUP_MODEL]);
  assert.deepEqual(time.waits, []);
});

test("a broken reply throws (the route shows a notice) and is NOT cached, so the next try asks again", async () => {
  const { parse, gemini } = make(["broken", "ok"]);
  await assert.rejects(parse(), /no text \(finishReason: SAFETY\)/);
  assert.equal((await parse()).from, MAIN_MODEL);
  assert.equal(gemini.calls.length, 2);
});

test("counter at 0: no call, the \"used up\" notice; the demo and cached chats still work", async () => {
  const time = fakeTime();
  const usage = createUsage({ file: join(tempDir(), "ai-usage.json"), models: [MAIN_MODEL, BACKUP_MODEL], now: time.now, limit: 1 });
  const { parse, gemini, ai } = make(["ok", 503], { time, usage });
  assert.equal((await parse()).from, MAIN_MODEL); // main: its 1 call
  assert.deepEqual(await parse("[29/10 9:05 AM] Ben: 1 cheese brownies"), { notice: AI_BUSY }); // backup: its 1 call
  assert.equal(ai.callsLeft(), 0);

  assert.deepEqual(await parse("[29/10 9:10 AM] Cal: 3 cookies"), { notice: usedUp(time.t) });
  assert.equal(gemini.calls.length, 2); // nothing called at 0
  assert.equal(usedUp(time.t), "Today's free AI reads are used up. Try again after 3 PM Malaysia time, or click Load demo.");
  assert.equal((await parse()).from, "cache"); // chats read earlier today
  assert.equal((await ai.parse({ text: DEMO, chatDate: "2026-10-28", menu })).from, "saved"); // Load demo
});

test("one model used up -> the other gets the whole 60 s, and the page is not told \"trying the backup\"", async () => {
  const time = fakeTime();
  const usage = createUsage({ file: join(tempDir(), "ai-usage.json"), models: [MAIN_MODEL, BACKUP_MODEL], now: time.now, limit: 1 });
  usage.take(MAIN_MODEL);
  const { parse, gemini, stages } = make(["ok"], { time, usage });
  assert.equal((await parse()).from, BACKUP_MODEL);
  assert.deepEqual(gemini.models(), [BACKUP_MODEL]);
  assert.deepEqual(time.timeouts, [60 * S]);
  assert.deepEqual(stages, []);
});

test("the counter starts again at midnight Pacific time (3 PM Malaysia time in October)", async () => {
  const time = fakeTime();
  const usage = createUsage({ file: join(tempDir(), "ai-usage.json"), models: [MAIN_MODEL, BACKUP_MODEL], now: time.now, limit: 1 });
  usage.take(MAIN_MODEL);
  usage.take(BACKUP_MODEL);
  const { parse, gemini } = make(["ok"], { time, usage });
  assert.match((await parse()).notice, /used up/);
  time.t = Date.UTC(2026, 9, 30, 6, 59); // 2:59 PM Malaysia time: still the same Pacific day
  assert.match((await parse()).notice, /used up/);
  time.t = Date.UTC(2026, 9, 30, 7, 0); // 3:00 PM Malaysia time = midnight Pacific
  assert.equal((await parse()).from, MAIN_MODEL);
  assert.equal(gemini.calls.length, 1);
});

test("mock mode never calls Gemini, even with a key", async () => {
  const { gemini } = make([]);
  const ai = createAi({ mode: "mock", apiKey: "fake-key-123", fetch: gemini.fetch, cacheDir: tempDir(), usage: createUsage({ file: join(tempDir(), "u.json"), models: [MAIN_MODEL] }) });
  assert.ok((await ai.parse({ text: CHATS, chatDate: CHAT_DATE, menu })).notice);
  assert.equal(gemini.calls.length, 0);
});
