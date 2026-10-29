// Tests for the app's REAL AI mode (Step 7, src/ai.js + src/gemini.js). Gemini is a FAKE fetch here:
// npm run check never calls the real AI and never needs a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, parseKey, NO_KEY, AI_BUSY, AI_REFUSED } from "../src/ai.js";
import { MAIN_MODEL, BACKUP_MODEL } from "../src/gemini.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const CHATS = "[29/10 9:00 AM] Zara: 2 jars of cookies for saturday pls";
const CHAT_DATE = "2026-10-29";
const ORDERS = [{ buyer: "Zara", status: "active", sourceMsgs: [1], items: [{ itemId: "cookies", qty: 2 }], deliveryDate: "2026-10-31", fulfilment: null, unclear: false, reason: "", note: "" }];
const reply = (orders = ORDERS) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ orders }) }] }, finishReason: "STOP" }] });

// A fake Gemini: answers[i] is used for call i (a status number, or "ok", "broken", "hang").
function fakeGemini(...answers) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const answer = answers[calls.length - 1] ?? "ok";
    if (answer === "hang") {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }
    if (answer === "ok") return new Response(reply(), { status: 200 });
    if (answer === "broken") return new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: answer, status: "UNAVAILABLE", message: "busy" } }), { status: answer });
  }
  return { fetch, calls, models: () => calls.map((c) => c.url.match(/models\/(.+):generateContent/)[1]) };
}

const make = (gemini, extra = {}) => {
  const cacheDir = join(mkdtempSync(join(tmpdir(), "chatching-ai-")), "ai-cache");
  const logs = [];
  const ai = createAi({ mode: "real", apiKey: "fake-key-123", fetch: gemini.fetch, cacheDir, timeoutMs: 200, log: (line) => logs.push(line), ...extra });
  return { ai, cacheDir, logs, parse: (text = CHATS) => ai.parse({ text, chatDate: CHAT_DATE, menu }) };
};

test("the demo chats are answered from the saved reply: 0 calls, even in real mode", async () => {
  const gemini = fakeGemini();
  const { ai } = make(gemini);
  const result = await ai.parse({ text: DEMO, chatDate: "2026-10-28", menu });
  assert.equal(result.from, "saved");
  assert.ok(result.orders.length > 0);
  assert.equal(gemini.calls.length, 0);
});

test("no key -> a friendly notice, no call", async () => {
  const gemini = fakeGemini();
  const { parse } = make(gemini, { apiKey: "" });
  assert.deepEqual(await parse(), { notice: NO_KEY });
  assert.equal(gemini.calls.length, 0);
});

test("one batched call to the main model; the key is in a header, never in the URL; the reply is cached", async () => {
  const gemini = fakeGemini("ok");
  const { parse, cacheDir, logs } = make(gemini);
  const first = await parse();
  assert.deepEqual([first.from, first.orders], [MAIN_MODEL, ORDERS]);
  assert.equal(gemini.calls.length, 1);
  assert.equal(gemini.calls[0].headers["x-goog-api-key"], "fake-key-123");
  assert.doesNotMatch(gemini.calls[0].url, /fake-key|key=/);
  assert.ok(gemini.calls[0].body.contents[0].parts[0].text.includes("Zara: 2 jars of cookies"));
  assert.ok(gemini.calls[0].body.generationConfig.responseSchema.properties.orders);
  assert.equal(readFileSync(join(cacheDir, `parse-${parseKey(CHATS, CHAT_DATE)}.json`), "utf8"), reply()); // byte for byte
  assert.ok(logs.every((line) => !line.includes("fake-key")));

  const again = await parse(`  ${CHATS}  \r\n\r\n`); // same chats, other spaces and line endings
  assert.equal(again.from, "cache");
  assert.equal(gemini.calls.length, 1); // no second call
});

test("main model overloaded (503) or rate-limited (429) -> the backup model answers", async () => {
  for (const status of [503, 429]) {
    const gemini = fakeGemini(status, "ok");
    const result = await make(gemini).parse();
    assert.deepEqual(gemini.models(), [MAIN_MODEL, BACKUP_MODEL], String(status));
    assert.equal(result.from, BACKUP_MODEL);
  }
});

test("main model too slow -> straight to the backup (never the same model again)", async () => {
  const gemini = fakeGemini("hang", "ok");
  const { parse, logs } = make(gemini);
  assert.equal((await parse()).from, BACKUP_MODEL);
  assert.deepEqual(gemini.models(), [MAIN_MODEL, BACKUP_MODEL]);
  assert.ok(logs.some((line) => /No answer within 0.2 s/.test(line)));
});

test("both models busy -> \"AI busy\" notice, nothing cached", async () => {
  const gemini = fakeGemini(503, 503);
  const { parse, cacheDir } = make(gemini);
  assert.deepEqual(await parse(), { notice: AI_BUSY });
  assert.equal(gemini.calls.length, 2);
  assert.ok(!existsSync(cacheDir) || readdirSync(cacheDir).length === 0);
});

test("a request Google refuses (400) is not retried on the backup", async () => {
  const gemini = fakeGemini(400);
  assert.deepEqual(await make(gemini).parse(), { notice: AI_REFUSED });
  assert.equal(gemini.calls.length, 1);
});

test("a broken reply throws (the route shows a notice) and is NOT cached, so the next try asks again", async () => {
  const gemini = fakeGemini("broken", "ok");
  const { parse } = make(gemini);
  await assert.rejects(parse(), /no text \(finishReason: SAFETY\)/);
  assert.equal((await parse()).from, MAIN_MODEL);
  assert.equal(gemini.calls.length, 2);
});

test("mock mode never calls Gemini, even with a key", async () => {
  const gemini = fakeGemini();
  const ai = createAi({ mode: "mock", apiKey: "fake-key-123", fetch: gemini.fetch, cacheDir: mkdtempSync(join(tmpdir(), "x-")) });
  assert.ok((await ai.parse({ text: CHATS, chatDate: CHAT_DATE, menu })).notice);
  assert.equal(gemini.calls.length, 0);
});
