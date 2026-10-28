// Tests for POST /api/parse (Step 4, Part 2): chat text + Chat date -> order rows, in mock mode.
// Each server gets its own temporary store file; the real data/runtime/ is never touched.
// Broken saved replies are written to a temporary folder and looked up by the same key as the demo.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi, demoReplies, parseKey, MOCK_UNKNOWN } from "../src/ai.js";

const CHAT = "2026-10-28";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const FIXTURE = readFileSync(new URL("./fixtures/real-order-no-timestamp.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };
const tempDir = () => mkdtempSync(join(tmpdir(), "chatching-"));

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ ai, logs = [] } = {}) {
  const config = loadConfig({});
  const server = createApp(config, { log: (line) => logs.push(line), storeFile: join(tempDir(), "orders.json"), ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, init) => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: await res.json() };
  };
  const parse = (body) => call("/api/parse", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { call, parse, logs };
}

// A mock AI whose saved replies are { text -> raw reply }, written to temporary files.
function aiWith(replies) {
  const dir = tempDir();
  const map = demoReplies();
  Object.entries(replies).forEach(([text, raw], i) => {
    const file = join(dir, `reply-${i}.json`);
    writeFileSync(file, raw);
    map.set(parseKey(text, CHAT), file);
  });
  return createAi({ mode: "mock", replies: map });
}
const geminiReply = (orders) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ orders }) }] } }] });

test("the demo chats -> Gemini's saved reply: 9 buyers, 7 ready worth RM 387.00, Priya needs a check", async () => {
  const { parse, call } = await start();
  const { status, body } = await parse({ text: DEMO, chatDate: CHAT });
  assert.equal(status, 200);
  assert.equal(body.notice, undefined);
  assert.equal(body.groups.length, 9);
  assert.equal(body.orders.length, 12);
  assert.deepEqual(body.totals, { orders: 7, total: "387.00" });
  assert.deepEqual(body.summary, { orders: 8, ready: 7, expected: "387.00", paidOrders: 0, paid: "0.00", needsCheck: 1 });
  assert.deepEqual(body.orders.filter((r) => r.unclear).map((r) => r.buyer), ["Priya"]);
  assert.deepEqual({ ...body.source, text: undefined }, { text: undefined, chatDate: CHAT, messages: 15 });
  // Saved: the page reload shows the same rows and source.
  const state = (await call("/api/state")).body;
  assert.deepEqual(state.orders, body.orders);
  assert.equal(state.source.text, DEMO);
});

test("the same demo chats with Windows line endings, blank lines and trailing spaces -> the same reply", async () => {
  const { parse } = await start();
  const messy = `\r\n${DEMO.replace(/\n/g, "  \r\n\r\n")}`;
  const { body } = await parse({ text: messy, chatDate: CHAT });
  assert.deepEqual(body.totals, { orders: 7, total: "387.00" });
});

test("any other text in mock mode -> the friendly mock notice (200, not an error), rows unchanged", async () => {
  const { parse, call } = await start();
  const before = (await call("/api/state")).body;
  for (const text of ["hello, are you open tomorrow?", FIXTURE, DEMO.replace("2 boxes", "4 boxes")]) {
    const { status, body } = await parse({ text, chatDate: CHAT });
    assert.equal(status, 200);
    assert.deepEqual(body, { notice: MOCK_UNKNOWN });
  }
  assert.equal(MOCK_UNKNOWN, "Mock mode only knows the demo chats - the real AI comes in Step 7.");
  assert.deepEqual((await call("/api/state")).body, before);
});

test("the demo chats with ANOTHER Chat date are not the demo (the date is part of the key)", async () => {
  const { parse } = await start();
  assert.deepEqual((await parse({ text: DEMO, chatDate: "2026-10-29" })).body, { notice: MOCK_UNKNOWN });
});

test("the limits: empty, no Chat date, 51 messages, 10,001 characters -> a friendly notice, rows unchanged", async () => {
  const { parse, call } = await start();
  const before = (await call("/api/state")).body;
  const many = Array.from({ length: 51 }, (_, i) => `[28/10 9:${String(i).padStart(2, "0")} AM] B${i}: 1 cookies`).join("\n");
  const cases = [
    [{ text: "  ", chatDate: CHAT }, /Paste some chat messages first/],
    [{ text: DEMO, chatDate: "" }, /Choose the Chat date/],
    [{ text: many, chatDate: CHAT }, /That's 51 messages\. ChatChing reads up to 50/],
    [{ text: "x".repeat(10_001), chatDate: CHAT }, /That paste is 10,001 characters/],
  ];
  for (const [send, notice] of cases) {
    const { status, body } = await parse(send);
    assert.equal(status, 200);
    assert.match(body.notice, notice);
  }
  assert.deepEqual((await call("/api/state")).body, before);
});

test("a request with the wrong shape -> 400 with what to send", async () => {
  const { parse } = await start();
  for (const send of [{}, { text: 42, chatDate: CHAT }, { text: DEMO }]) {
    const { status, body } = await parse(send);
    assert.equal(status, 400);
    assert.match(body.error, /Send \{ "text": .*"chatDate"/);
  }
});

test("a saved reply with BAD data -> every order becomes a row; the bad ones are unclear, none dropped", async () => {
  const text = "[28/10 9:00 AM] Ali: 2 cookies\n[28/10 9:05 AM] Bea: 1 bahulu";
  const orders = [
    { buyer: "Ali", status: "active", sourceMsgs: [1], items: [{ itemId: "cookies", qty: 2 }], deliveryDate: CHAT, fulfilment: null, unclear: false, reason: "", note: "" },
    { buyer: "Bea", status: "active", sourceMsgs: [2, 9], items: [{ itemId: "pizza", qty: "3" }], deliveryDate: "2026-12-25", fulfilment: "drone", unclear: false, reason: "", note: "" },
    null,
    { buyer: "Cal", status: "maybe", sourceMsgs: [], items: [null] },
  ];
  const { parse } = await start({ ai: aiWith({ [text]: geminiReply(orders) }) });
  const { status, body } = await parse({ text, chatDate: CHAT });
  assert.equal(status, 200);
  assert.equal(body.orders.length, 4);
  assert.deepEqual(body.orders.map((r) => r.unclear), [false, true, true, true]);
  const bea = body.orders[1].reason;
  for (const part of [/Unknown item "pizza"/, /Quantity must be a whole number/, /Message 9 is not in the chat/, /more than 14 days after/, /Unknown pickup or delivery "drone"/]) {
    assert.match(bea, part);
  }
  assert.match(body.orders[3].reason, /Unknown order status "maybe"/);
  assert.deepEqual(body.totals, { orders: 1, total: "50.00" }); // only Ali: 2 × RM 25.00 from the menu
});

test("a saved reply that can't be read (not JSON, no orders list) -> a friendly notice, rows unchanged, details logged", async () => {
  const replies = {
    "[28/10 9:00 AM] Ali: hi": "{ not json",
    "[28/10 9:01 AM] Ali: hi": JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"orders":"nope"}' }] } }] }),
    "[28/10 9:02 AM] Ali: hi": JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }),
  };
  const { parse, call, logs } = await start({ ai: aiWith(replies) });
  const before = (await call("/api/state")).body;
  for (const text of Object.keys(replies)) {
    const { status, body } = await parse({ text, chatDate: CHAT });
    assert.equal(status, 200);
    assert.deepEqual(body, { notice: "The AI's answer could not be read, so your orders were not changed. Please try again." });
  }
  assert.deepEqual((await call("/api/state")).body, before);
  assert.equal(logs.filter((line) => line.startsWith("Warning: the AI reply could not be read")).length, 3);
  assert.ok(logs.some((line) => /SAFETY/.test(line)));
});

test("never more than one parse at a time: a second request while one is reading gets a notice", async () => {
  let release;
  let started;
  const isReading = new Promise((resolve) => (started = resolve));
  const slowAi = {
    async parse() {
      started();
      await new Promise((resolve) => (release = resolve));
      return { orders: [] };
    },
  };
  const { parse } = await start({ ai: slowAi });
  const first = parse({ text: DEMO, chatDate: CHAT });
  await isReading;
  const second = await parse({ text: DEMO, chatDate: CHAT });
  assert.deepEqual(second.body, { notice: "Already reading orders. Please wait for that to finish." });
  release();
  assert.equal((await first).status, 200);
  // Finished: the next one is read again (the lock is released).
  const third = parse({ text: DEMO, chatDate: CHAT });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  assert.equal((await third).status, 200);
});

test("other AI modes (real, off) are not built yet -> a friendly notice, not a crash", async () => {
  for (const mode of ["real", "off"]) {
    const { parse } = await start({ ai: createAi({ mode }) });
    const { status, body } = await parse({ text: DEMO, chatDate: CHAT });
    assert.equal(status, 200);
    assert.match(body.notice, mode === "real" ? /Step 7/ : /Step 12/);
  }
});
