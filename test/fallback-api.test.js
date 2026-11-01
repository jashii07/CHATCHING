// Tests for "Read without AI" in POST /api/parse (Step 10, Part 1). The seller chooses it: a notice about the
// AI (busy, too slow, used up, refused) carries readWithoutAi: true so the page can offer the button, and
// { withoutAi: true } reads the chats with src/fallback-parse.js: no AI call, the same checks, the same rows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AI_BUSY, createAi, usedUp } from "../src/ai.js";
import { testVisitor } from "../scripts/test-visitor.mjs";

const CHAT = "2026-10-28";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const JSON_HEADERS = { "Content-Type": "application/json" };

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

// A fake AI that always answers with this notice, and counts how often it was asked.
const noticeAi = (notice) => {
  const ai = { calls: 0, async parse() { ai.calls++; return { notice }; }, callsLeft: () => 0 };
  return ai;
};

async function start({ ai }) {
  const { dir: visitorsDir, fetch } = testVisitor();
  const server = createApp(loadConfig({}), { log: () => {}, visitorsDir, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = async (path, init) => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: await res.json() };
  };
  const parse = (body) => call("/api/parse", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { call, parse };
}

test("a busy AI -> the notice offers Read without AI; reading without AI gives rows with no AI call", async () => {
  const ai = noticeAi(AI_BUSY);
  const { parse, call } = await start({ ai });
  const busy = await parse({ text: DEMO, chatDate: CHAT });
  assert.deepEqual(busy.body, { notice: AI_BUSY, readWithoutAi: true });

  const { status, body } = await parse({ text: DEMO, chatDate: CHAT, withoutAi: true });
  assert.equal(status, 200);
  assert.equal(ai.calls, 1, "reading without AI never asks the AI");
  assert.equal(body.groups.length, 10);
  assert.deepEqual(body.totals, { orders: 1, total: "72.00" }); // only Mei Ling is clear
  assert.equal(body.summary.needsCheck, 9);
  assert.deepEqual({ ...body.source, text: undefined }, { text: undefined, chatDate: CHAT, messages: 18, reader: "fallback" });
  assert.match(body.orders.find((row) => row.buyer === "Lina").reason, /^read without AI, this buyer changed their order\./);
  // Saved like any read: a reload shows the same rows and still knows they were read without AI.
  const state = (await call("/api/state")).body;
  assert.equal(state.source.reader, "fallback");
  assert.deepEqual(state.totals, body.totals);
});

test("used up, refused, unreadable, mock mode and AI_MODE=off all offer Read without AI", async () => {
  for (const notice of [usedUp(Date.now()), "The AI could not read these chats, so your orders were not changed."]) {
    assert.equal((await (await start({ ai: noticeAi(notice) })).parse({ text: "[28/10 9:00] Zara: 2 cookies", chatDate: CHAT })).body.readWithoutAi, true);
  }
  const broken = { async parse() { return { orders: "not a list" }; } }; // checkOrders throws -> the friendly notice
  assert.equal((await (await start({ ai: broken })).parse({ text: DEMO, chatDate: CHAT })).body.readWithoutAi, true);
  const mock = await (await start({ ai: createAi({ mode: "mock" }) })).parse({ text: "[28/10 9:00] Zara: 2 cookies", chatDate: CHAT });
  assert.equal(mock.body.readWithoutAi, true);
  const off = await (await start({ ai: createAi({ mode: "off" }) })).parse({ text: DEMO, chatDate: CHAT });
  assert.deepEqual(off.body, { notice: "AI reading is switched off on this server (AI_MODE=off), so the chats can only be read without AI.", readWithoutAi: true });
});

test("notices that are not about the AI do not offer it: an empty or too-long paste, a missing Chat date", async () => {
  const { parse } = await start({ ai: noticeAi(AI_BUSY) });
  for (const body of [{ text: " ", chatDate: CHAT }, { text: "x".repeat(15_001), chatDate: CHAT }, { text: DEMO, chatDate: "" }]) {
    for (const withoutAi of [false, true]) {
      const reply = (await parse({ ...body, withoutAi })).body;
      assert.ok(reply.notice && !reply.readWithoutAi, JSON.stringify(reply));
    }
  }
});

test("an AI read after a read without AI is a normal read again (no fallback mark)", async () => {
  const { parse } = await start({ ai: createAi({ mode: "mock" }) });
  assert.equal((await parse({ text: DEMO, chatDate: CHAT, withoutAi: true })).body.source.reader, "fallback");
  const again = await parse({ text: DEMO, chatDate: CHAT });
  assert.equal(again.body.source.reader, undefined);
  assert.deepEqual(again.body.totals, { orders: 7, total: "366.00" });
});

test("withoutAi must be true, false or left out", async () => {
  const { parse } = await start({ ai: noticeAi(AI_BUSY) });
  const { status, body } = await parse({ text: DEMO, chatDate: CHAT, withoutAi: "yes" });
  assert.equal(status, 400);
  assert.match(body.error, /withoutAi/);
});

test("the ready-to-send texts ride along with every read and edit: Priya's question goes once she is fixed", async () => {
  const { parse, call } = await start({ ai: createAi({ mode: "mock" }) });
  const { body } = await parse({ text: DEMO, chatDate: CHAT });
  const priya = () => body.texts.find((t) => t.buyer === "Priya");
  assert.equal(priya().question, "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?");
  assert.equal(body.texts.length, body.groups.length);
  const id = body.orders.find((row) => row.buyer === "Priya").id;
  const edit = await call(`/api/orders/${id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ itemId: "cheese_brownies" }) });
  assert.equal(edit.body.texts.find((t) => t.buyer === "Priya").question, null);
  assert.deepEqual((await call("/api/state")).body.texts, edit.body.texts);
});
