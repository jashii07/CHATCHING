// Tests for the per-visitor rate limit (Step 11, src/rate-limit.js) on the routes that call Gemini or
// PayPal. A FAKE clock: "10 minutes later" passes in a millisecond. Fake keys only; never the real .env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { testVisitor } from "../scripts/test-visitor.mjs";

const MIN = 60_000;
const JSON_HEADERS = { "Content-Type": "application/json" };

test("the limits: per visitor, per route, in any 10 minutes", () => {
  assert.deepEqual(RATE_LIMITS, {
    pickup: { limit: 60, windowMs: 10 * MIN },
    parse: { limit: 6, windowMs: 10 * MIN },
    invoices: { limit: 100, windowMs: 10 * MIN }, // per buyer sent: test/review-fixes.test.js, #9
    payment: { limit: 20, windowMs: 10 * MIN },
    refresh: { limit: 60, windowMs: 10 * MIN },
    pairNew: { limit: 20, windowMs: 10 * MIN },
    pairOpen: { limit: 30, windowMs: 10 * MIN },
    order: { limit: 90, windowMs: 10 * MIN }, // the buyer's "Your order" page, 6 Nov
    orderAnswer: { limit: 20, windowMs: 10 * MIN },
  });
});

test("take(): allowed up to the limit, then the wait until the oldest request leaves the 10 minutes", () => {
  const clock = { t: 0 };
  const limiter = createRateLimiter({ now: () => clock.t });
  for (let i = 0; i < 6; i++) {
    assert.equal(limiter.take("parse", "1.1.1.1"), null);
    clock.t += MIN; // one read a minute
  }
  assert.equal(limiter.take("parse", "1.1.1.1"), 4 * MIN); // at 6 min: the first read (at 0) leaves at 10 min
  assert.equal(limiter.take("parse", "2.2.2.2"), null, "another visitor has their own count");
  assert.equal(limiter.take("refresh", "1.1.1.1"), null, "another route has its own count");
  clock.t = 10 * MIN;
  assert.equal(limiter.take("parse", "1.1.1.1"), null, "the first read has left the window");
  assert.equal(limiter.take("parse", "1.1.1.1"), MIN, "refused tries are not counted: the next slot is when the read at 1 min leaves");
});

test("an unknown route name is a programming mistake, not a silent pass", () => {
  assert.throws(() => createRateLimiter().take("nope", "1.1.1.1"), /No rate limit called "nope"/);
});

test("memory stays small: past maxVisitors, visitors with nothing recent are forgotten first", () => {
  const clock = { t: 0 };
  const limiter = createRateLimiter({ now: () => clock.t, maxVisitors: 3 });
  limiter.take("parse", "old-1");
  limiter.take("parse", "old-2");
  clock.t = 11 * MIN; // both are now outside their 10 minutes
  limiter.take("parse", "new-1");
  limiter.take("parse", "new-2");
  assert.equal(limiter.size(), 2);
  for (const visitor of ["a", "b", "c", "d"]) limiter.take("parse", visitor);
  assert.ok(limiter.size() <= 3);
});

test("the words: plain, in whole minutes (at least 1)", () => {
  assert.equal(slowDown(4 * MIN), "You're going a bit fast for this free demo. Please try again in 4 minutes.");
  assert.equal(slowDown(10_000), "You're going a bit fast for this free demo. Please try again in 1 minute.");
  assert.equal(slowDown(61_000), "You're going a bit fast for this free demo. Please try again in 2 minutes.");
});

// The real app with a fake clock and small limits (2 per route), so each test stays short.
async function start(env = {}) {
  const clock = { t: Date.UTC(2026, 10, 5, 4) };
  const small = Object.fromEntries(Object.keys(RATE_LIMITS).map((route) => [route, { limit: 2, windowMs: 10 * MIN }]));
  const logs = [];
  const { dir: visitorsDir, fetch } = testVisitor();
  const app = createApp(loadConfig(env), {
    log: (line) => logs.push(line),
    visitorsDir,
    limiter: createRateLimiter({ limits: small, now: () => clock.t }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${server.address().port}`;
  const post = async (path, body = {}, headers = {}) => {
    const res = await fetch(base + path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const state = async () => (await fetch(`${base}/api/state`)).json();
  return { post, state, clock, logs, close: () => (server.closeAllConnections(), server.close()) };
}

test("Read orders: the 3rd read in 10 minutes gets a friendly 200 notice (with Read without AI), rows unchanged; 10 minutes later it works again", async (t) => {
  const { post, state, clock, logs, close } = await start();
  t.after(close);
  const chats = { text: "[29/10 9:00 AM] Zara: 2 jars of cookies for saturday pls", chatDate: "2026-10-29" };
  for (let i = 0; i < 2; i++) assert.equal((await post("/api/parse", chats)).status, 200);
  const before = (await state()).orders;
  const limited = await post("/api/parse", chats);
  assert.deepEqual(limited, { status: 200, body: { notice: slowDown(10 * MIN), rateLimited: true, readWithoutAi: true } });
  assert.deepEqual((await state()).orders, before, "nothing was read");
  assert.ok(logs.some((line) => /^Rate limit: too many parse requests from one visitor/.test(line)));
  assert.ok(logs.every((line) => !/127\.0\.0\.1|::1/.test(line)), "visitors' addresses are never logged");

  const withoutAi = await post("/api/parse", { ...chats, withoutAi: true });
  assert.equal(withoutAi.status, 200);
  assert.ok(withoutAi.body.orders?.length, "Read without AI makes no AI call, so it is never limited");

  clock.t += 10 * MIN;
  assert.equal((await post("/api/parse", chats)).body.rateLimited, undefined);
});

test("Refresh status and Record payment are limited too: 200 notice, the route never runs", async (t) => {
  const { post, close } = await start(); // no PayPal keys: a route that runs answers 503 "not configured"
  t.after(close);
  for (const path of ["/api/invoices/refresh", "/api/invoices/INV2-TEST/payment"]) {
    for (let i = 0; i < 2; i++) assert.equal((await post(path, { method: "CASH" })).status, 503, `${path} runs at first`);
    const limited = await post(path, { method: "CASH" });
    assert.deepEqual(limited, { status: 200, body: { notice: slowDown(10 * MIN), rateLimited: true } }, path);
  }
});

test("on Render, each visitor (X-Forwarded-For) has their own count", async (t) => {
  const { post, close } = await start({ RENDER: "true" });
  t.after(close);
  const visitor = (ip) => ({ "X-Forwarded-For": ip });
  for (let i = 0; i < 2; i++) await post("/api/invoices/refresh", {}, visitor("203.0.113.7"));
  assert.equal((await post("/api/invoices/refresh", {}, visitor("203.0.113.7"))).body.rateLimited, true);
  assert.equal((await post("/api/invoices/refresh", {}, visitor("198.51.100.9"))).status, 503, "another visitor still gets through");
});

test("off Render, a made-up X-Forwarded-For header can't dodge the limit", async (t) => {
  const { post, close } = await start();
  t.after(close);
  for (const ip of ["10.0.0.1", "10.0.0.2"]) await post("/api/invoices/refresh", {}, { "X-Forwarded-For": ip });
  assert.equal((await post("/api/invoices/refresh", {}, { "X-Forwarded-For": "10.0.0.3" })).body.rateLimited, true);
});
