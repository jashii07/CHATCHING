// Tests for per-visitor tables through the real app (DECISIONS.md, 31 Oct): every browser gets its own table,
// so no judge can see or reset another judge's orders. The AI counter and the rate limits stay shared.
// PayPal is the FAKE in scripts/fake-paypal.mjs, shared by all visitors of a server, like the real sandbox.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp, ORDER_GONE } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { MAX_VISITORS, VISITOR_COOKIE, isVisitorId, newVisitorId } from "../src/visitors.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const DAY = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "Content-Type": "application/json" };
const READ = { text: DEMO, chatDate: "2026-10-28" };
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";
const READING = "Already reading orders. Please wait for that to finish.";
const SENDING = "Invoices are being sent right now. Please wait for that to finish.";

const tempDir = () => mkdtempSync(join(tmpdir(), "chatching-visitors-"));
const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS, dir = tempDir(), logs = [], fake = fakePayPal(), ...options } = {}) {
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: (line) => logs.push(line), visitorsDir: dir, paypal, ...options }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { base: `http://localhost:${server.address().port}`, fake, dir, logs };
}

// One browser: it keeps the cookie the server gives it, like a real one.
function browser(app, startCookie = null) {
  let cookie = startCookie;
  const call = async (path, method = "GET", body, headers = {}) => {
    const res = await fetch(app.base + path, { method, headers: { ...JSON_HEADERS, ...(cookie && { Cookie: cookie }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const [setCookie] = res.headers.getSetCookie();
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: await res.json(), setCookie, cacheControl: res.headers.get("cache-control") };
  };
  return {
    call,
    id: () => cookie?.split("=")[1],
    state: async () => (await call("/api/state")).body,
    read: async () => (await call("/api/parse", "POST", READ)).body,
    send: async () => (await call("/api/invoices", "POST", {})).body,
  };
}

const visitorFiles = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const numbersOf = (state) => [...new Set(state.orders.map((row) => row.invoiceNumber).filter(Boolean))];

// ---- A new visitor ----

test("a new visitor gets a random id in a safe cookie and an empty table", async () => {
  const app = await start();
  const judge = browser(app);
  const { status, body, setCookie } = await judge.call("/api/state");
  assert.equal(status, 200);
  assert.deepEqual([body.orders, body.groups, body.source], [[], [], null]);
  assert.equal(body.totals.orders, 0);
  assert.ok(isVisitorId(judge.id()), setCookie);
  assert.match(setCookie, new RegExp(`^${VISITOR_COOKIE}=[0-9a-f]{32};`));
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Lax/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; Max-Age=1209600/, "14 days, like the cleanup");
  assert.doesNotMatch(setCookie, /; Secure/, "plain http on this laptop");
});

test("a new visitor who only looks leaves no file behind", async () => {
  const app = await start();
  await browser(app).state();
  assert.deepEqual(visitorFiles(app.dir), []);
});

test("the same browser keeps the same id and table, and each visit renews the 14 days", async () => {
  const app = await start();
  const judge = browser(app);
  await judge.read();
  const id = judge.id();
  const { body, setCookie } = await judge.call("/api/state");
  assert.equal(judge.id(), id);
  assert.equal(body.orders.length, 12);
  assert.match(setCookie, /; Max-Age=1209600/);
});

test("Secure on HTTPS: on Render the cookie is Secure when the visitor came over HTTPS", async () => {
  const app = await start({ env: { RENDER: "true" } });
  const { setCookie } = await browser(app).call("/api/state", "GET", undefined, { "X-Forwarded-Proto": "https" });
  assert.match(setCookie, /; Secure/);
});

test("off Render a made-up X-Forwarded-Proto header is ignored", async () => {
  const app = await start();
  const { setCookie } = await browser(app).call("/api/state", "GET", undefined, { "X-Forwarded-Proto": "https" });
  assert.doesNotMatch(setCookie, /; Secure/);
});

test("the health check and the page itself make no visitor: no cookie, no file (Render pings these all day)", async () => {
  const app = await start();
  for (const path of ["/api/health", "/"]) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    assert.deepEqual(res.headers.getSetCookie(), [], path);
  }
  assert.deepEqual(visitorFiles(app.dir), []);
});

test("every API reply says no-store: one visitor's table must never sit in a shared cache", async () => {
  const app = await start();
  assert.equal((await browser(app).call("/api/state")).cacheControl, "no-store");
});

// ---- A bad or missing cookie ----

test("a bad cookie gets a fresh empty table and a new good id; nothing is read or written outside the folder", async () => {
  const dir = join(tempDir(), "visitors");
  const app = await start({ dir });
  const outside = join(dirname(dir), "orders.json");
  writeFileSync(outside, JSON.stringify({ rows: [{ id: "r1", buyer: "Someone else" }] }));
  const bad = ["../orders", "..%2Forders", "..\\orders", "", "x", "A".repeat(32), `${"a".repeat(32)}0`, "a".repeat(31), "%00"];
  for (const value of bad) {
    const judge = browser(app, `${VISITOR_COOKIE}=${value}`);
    const { body, setCookie } = await judge.call("/api/state");
    assert.deepEqual(body.orders, [], value);
    assert.ok(setCookie, value);
    assert.ok(isVisitorId(judge.id()), value);
    await judge.call("/api/parse", "POST", { ...READ, withoutAi: true }); // never rate limited: this loop reads 9 times
    assert.ok((await judge.state()).orders.length > 0, value);
  }
  assert.deepEqual(visitorFiles(dirname(dir)).sort(), ["orders.json", "visitors"]);
  assert.equal(visitorFiles(dir).length, bad.length);
  assert.ok(visitorFiles(dir).every((name) => /^[0-9a-f]{32}\.json$/.test(name)));
});

test("a good id with nothing saved (a server that woke up on a wiped disk) is a fresh empty table", async () => {
  const app = await start();
  const judge = browser(app, `${VISITOR_COOKIE}=${newVisitorId()}`);
  const { body, status } = await judge.call("/api/state");
  assert.deepEqual([status, body.orders], [200, []]);
});

test("a broken visitor file is a fresh empty table with a quiet warning, never a crash; the id is not logged", async () => {
  const dir = tempDir();
  const id = newVisitorId();
  writeFileSync(join(dir, `${id}.json`), "{ broken");
  const logs = [];
  const app = await start({ dir, logs });
  const judge = browser(app, `${VISITOR_COOKIE}=${id}`);
  assert.deepEqual((await judge.state()).orders, []);
  assert.equal((await judge.read()).orders.length, 12);
  assert.ok(logs.some((line) => /Warning: could not read/.test(line)));
  assert.ok(logs.every((line) => !line.includes(id)));
});

test("the visitor id never reaches the logs", async () => {
  const logs = [];
  const app = await start({ logs });
  const judge = browser(app);
  await judge.read();
  await judge.send();
  await judge.call("/api/reset", "POST", {});
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => !line.includes(judge.id())));
});

// ---- Two visitors at once ----

test("two visitors never see each other's rows", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.state();
  await ben.state();
  assert.notEqual(ana.id(), ben.id());
  await ana.read();
  assert.equal((await ana.state()).orders.length, 12);
  assert.deepEqual((await ben.state()).orders, [], "Ana's read doesn't reach Ben");
  await ben.call("/api/parse", "POST", { ...READ, withoutAi: true });
  const anaLina = (await ana.state()).orders.find((row) => row.buyer === "Lina");
  assert.equal(anaLina.qty, 3);
  const edit = await ben.call(`/api/orders/${(await ben.state()).orders.find((row) => row.buyer === "Lina").id}`, "PUT", { qty: 9 });
  assert.equal(edit.status, 200);
  assert.equal((await ana.state()).orders.find((row) => row.buyer === "Lina").qty, 3, "Ben's edit doesn't reach Ana");
});

test("a visitor can't reach another visitor's row, buyer panel, invoice or QR code by guessing its id", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ana.send();
  const lina = (await ana.state()).orders.find((row) => row.buyer === "Lina");
  const before = (await ana.state()).orders;
  assert.equal((await ben.call(`/api/orders/${lina.id}`, "PUT", { qty: 9 })).status, 404);
  assert.deepEqual((await ben.call(`/api/buyers/${lina.id}/panel`)).body, { notice: ORDER_GONE }, "friendly words, and none of Lina's messages");
  assert.equal((await ben.call(`/api/invoices/${lina.invoiceId}/qr`)).status, 404);
  const payment = app.fake.count("payment");
  assert.equal((await ben.call(`/api/invoices/${lina.invoiceId}/payment`, "POST", { method: "CASH" })).status, 404);
  assert.equal(app.fake.count("payment"), payment, "never reached PayPal");
  assert.deepEqual((await ana.state()).orders, before);
});

test("a saved QR code stays with its visitor", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ana.send();
  const { invoiceId } = (await ana.state()).orders.find((row) => row.buyer === "Lina");
  assert.ok((await ana.call(`/api/invoices/${invoiceId}/qr`)).body.png);
  assert.equal((await ben.call(`/api/invoices/${invoiceId}/qr`)).status, 404, "Ana's kept QR code doesn't open it for Ben");
});

test("Reset demo clears only that visitor's table", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ben.read();
  await ben.send();
  await ana.call("/api/reset", "POST", {});
  assert.deepEqual((await ana.state()).orders, []);
  const benNow = await ben.state();
  assert.equal(benNow.orders.length, 12);
  assert.equal(numbersOf(benNow).length, 7);
});

test("New batch affects only that visitor: their batch is kept in their own file, the other's table and batch stay", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ben.read();
  await ana.send();
  const anaBatch = (await ana.state()).batch;
  const benBefore = await ben.state();
  await ana.call("/api/new-batch", "POST", {});
  assert.deepEqual((await ana.state()).orders, []);
  assert.deepEqual((await ben.state()).orders, benBefore.orders);
  assert.equal((await ben.state()).batch, benBefore.batch);
  const saved = JSON.parse(readFileSync(join(app.dir, `${ana.id()}.json`), "utf8"));
  assert.deepEqual(saved.batches.map((b) => b.batch), [anaBatch]);
  assert.equal(saved.batches[0].rows.filter((row) => row.payerLink).length, 8);
  assert.equal(JSON.parse(readFileSync(join(app.dir, `${ben.id()}.json`), "utf8")).batches.length, 0);
});

test("the batch rule is per visitor: Ana's sent invoices never stop Ben reading or loading the demo", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ana.send();
  assert.deepEqual((await ana.call("/api/parse", "POST", READ)).body, { notice: INVOICED });
  assert.deepEqual((await ana.call("/api/demo")).body, { notice: INVOICED });
  assert.equal((await ben.call("/api/demo")).body.messages, 18);
  assert.equal((await ben.read()).orders.length, 12);
});

test("no invoice number clash: the same chats from two visitors make 14 invoices, each with its own number", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ben.read();
  const [anaSent, benSent] = [await ana.send(), await ben.send()];
  assert.equal(anaSent.sent.length + benSent.sent.length, 14);
  assert.ok([...anaSent.sent, ...benSent.sent].every((sent) => sent.reused === false), "nobody took over someone else's invoice");
  assert.deepEqual([...anaSent.failed, ...benSent.failed], []);
  const numbers = [...numbersOf(await ana.state()), ...numbersOf(await ben.state())];
  assert.equal(new Set(numbers).size, 14);
  assert.ok(numbers.every((number) => /^CHATCHING-[A-Z0-9]{12}-\d{2}$/.test(number) && number.length <= 25), numbers[0]);
  assert.equal(app.fake.count("search"), 0, "PayPal never reported a duplicate");
});

test("the double-invoice guard is per visitor: Ana's second click makes nothing, Ben's first click still works", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ana.send();
  assert.deepEqual((await ana.send()).sent, []);
  assert.equal(app.fake.invoices.size, 7);
  await ben.read();
  assert.equal((await ben.send()).sent.length, 7);
  assert.equal(app.fake.invoices.size, 14);
});

test("Ana's invoices being sent never hold Ben up (locks are per visitor)", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ben.read();
  const release = app.fake.hold();
  const held = app.fake.waiting("create");
  const sending = ana.send();
  await held;
  assert.deepEqual((await ana.call("/api/reset", "POST", {})).body, { notice: SENDING });
  assert.deepEqual((await ana.call("/api/parse", "POST", READ)).body, { notice: SENDING });
  assert.deepEqual((await ben.call("/api/reset", "POST", {})).body.orders, []);
  assert.equal((await ben.read()).orders.length, 12);
  release();
  assert.equal((await sending).sent.length, 7);
});

test("Ana's slow AI read never holds Ben up, and his progress words stay his own", async () => {
  let release;
  const calls = [];
  const ai = {
    parse({ text, onStage }) {
      calls.push(text);
      if (calls.length > 1) return { notice: "Ben's read" };
      onStage("backup");
      return new Promise((resolve) => (release = () => resolve({ notice: "Ana's read" })));
    },
  };
  const app = await start({ ai });
  const [ana, ben] = [browser(app), browser(app)];
  await ana.state(); // the page always loads first, so she has her cookie before two requests overlap
  const reading = ana.call("/api/parse", "POST", READ);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await ana.call("/api/parse", "POST", READ)).body, { notice: READING });
  assert.deepEqual([(await ana.call("/api/parse/progress")).body.reading, (await ana.call("/api/parse/progress")).body.stage], [true, "backup"]);
  const benProgress = (await ben.call("/api/parse/progress")).body;
  assert.deepEqual([benProgress.reading, benProgress.stage], [false, null]);
  assert.equal((await ben.call("/api/parse", "POST", READ)).body.notice, "Ben's read");
  release();
  assert.equal((await reading).body.notice, "Ana's read");
});

test("Refresh status asks PayPal only about the visitor's own invoices", async () => {
  const app = await start();
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ana.send();
  await ben.state();
  const gets = app.fake.count("get");
  const { body } = await ben.call("/api/invoices/refresh", "POST", {});
  assert.deepEqual([body.checked, body.changed], [0, []]);
  assert.equal(app.fake.count("get"), gets);
});

test("Ben's paid invoice shows on Ben's table only", async () => {
  let clock = Date.UTC(2026, 10, 5, 4);
  const app = await start({ now: () => clock });
  const [ana, ben] = [browser(app), browser(app)];
  await ana.read();
  await ben.read();
  await ana.send();
  await ben.send();
  const { invoiceId } = (await ben.state()).orders.find((row) => row.buyer === "Lina");
  app.fake.pay(invoiceId);
  clock += 60_000;
  const reply = (await ben.call("/api/invoices/refresh", "POST", {})).body;
  assert.deepEqual(reply.changed.map((change) => change.buyer), ["Lina"]);
  clock += 60_000;
  assert.deepEqual((await ana.call("/api/invoices/refresh", "POST", {})).body.changed, []);
  assert.ok((await ana.state()).orders.every((row) => row.invoiceStatus !== "Paid"));
});

// ---- What stays shared ----

test("the AI daily counter stays global: one visitor's read lowers the count for everyone", async () => {
  let left = 40;
  const ai = { parse: () => (left--, { notice: "read" }), callsLeft: () => left };
  const app = await start({ ai });
  const [ana, ben] = [browser(app), browser(app)];
  assert.equal((await ben.state()).aiCallsLeft, 40);
  await ana.call("/api/parse", "POST", READ);
  assert.equal((await ben.state()).aiCallsLeft, 39);
  assert.equal((await ben.call("/api/parse/progress")).body.aiCallsLeft, 39);
});

test("the rate limits stay per IP address: two visitors on one address share the limit", async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 4) };
  const small = Object.fromEntries(Object.keys(RATE_LIMITS).map((route) => [route, { limit: 2, windowMs: 600_000 }]));
  const app = await start({ env: {}, limiter: createRateLimiter({ limits: small, now: () => clock.t }) });
  const [ana, ben] = [browser(app), browser(app)];
  for (let i = 0; i < 2; i++) await ana.call("/api/invoices/refresh", "POST", {});
  assert.deepEqual((await ben.call("/api/invoices/refresh", "POST", {})).body, { notice: slowDown(600_000), rateLimited: true });
});

// ---- Saved files ----

test("a visitor's table survives a server restart; the other visitor's stays their own", async () => {
  const dir = tempDir();
  const first = await start({ dir });
  const [ana, ben] = [browser(first), browser(first)];
  await ana.read();
  await ben.state();
  const again = await start({ dir });
  assert.equal((await browser(again, `${VISITOR_COOKIE}=${ana.id()}`).state()).orders.length, 12);
  assert.deepEqual((await browser(again, `${VISITOR_COOKIE}=${ben.id()}`).state()).orders, []);
});

test("old files are cleaned up when the server starts", async () => {
  const dir = tempDir();
  const [oldId, newId] = [newVisitorId(), newVisitorId()];
  for (const [id, days] of [[oldId, 15], [newId, 2]]) {
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ rows: [], source: null }));
    const when = new Date(Date.now() - days * DAY);
    utimesSync(file, when, when);
  }
  await start({ dir });
  assert.deepEqual(visitorFiles(dir), [`${newId}.json`]);
});

test("the 501st visitor's first save removes the oldest file, so at most 500 stay", async () => {
  const dir = tempDir();
  const ids = Array.from({ length: MAX_VISITORS }, newVisitorId);
  ids.forEach((id, i) => {
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ rows: [], source: null }));
    const when = new Date(Date.now() - (i + 1) * 60_000);
    utimesSync(file, when, when);
  });
  const app = await start({ dir });
  const judge = browser(app);
  await judge.read();
  const left = visitorFiles(dir);
  assert.equal(left.length, MAX_VISITORS);
  assert.ok(left.includes(`${judge.id()}.json`));
  assert.ok(!left.includes(`${ids.at(-1)}.json`), "the oldest went first");
  assert.ok(left.includes(`${ids.at(-2)}.json`));
});

test("coming back keeps a saved table from going old: a page load marks the file as used", async () => {
  const dir = tempDir();
  const id = newVisitorId();
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ rows: [], source: null }));
  const when = new Date(Date.now() - 13 * DAY);
  utimesSync(file, when, when);
  const app = await start({ dir });
  await browser(app, `${VISITOR_COOKIE}=${id}`).state();
  assert.ok(Date.now() - statSync(file).mtimeMs < DAY);
});
