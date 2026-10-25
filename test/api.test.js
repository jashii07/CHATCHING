// Tests for the API reply shapes and the error handler.
// Starts the real app on a free port with FAKE keys; the real .env is never loaded.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createApp, errorHandler } from "../src/app.js";

const FAKE = {
  PAYPAL_CLIENT_ID: "fake-client-id-123",
  PAYPAL_CLIENT_SECRET: "fake-secret-456",
  GEMINI_API_KEY: "fake-gemini-789",
};
const MENU = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const JSON_HEADERS = { "Content-Type": "application/json" };

let server;
let base;
const logs = [];

before(async () => {
  const app = createApp(loadConfig(FAKE), { log: (line) => logs.push(line) });
  server = app.listen(0); // 0 = any free port
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(path, init) {
  const res = await fetch(base + path, init);
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
}

test("GET /api/health -> { ok: true }", async () => {
  const res = await call("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
});

test("GET /api/state -> menu, empty orders, AI mode, placeholder counter, true/false key flags", async () => {
  const res = await call("/api/state");
  assert.equal(res.status, 200);
  const state = JSON.parse(res.text);
  assert.deepEqual(Object.keys(state).sort(), ["aiCallsLeft", "aiMode", "geminiConfigured", "menu", "orders", "paypalConfigured"]);
  assert.deepEqual(state.menu, MENU);
  assert.deepEqual(state.orders, []);
  assert.equal(state.aiMode, "mock");
  assert.equal(typeof state.aiCallsLeft, "number");
  assert.equal(state.paypalConfigured, true);
  assert.equal(state.geminiConfigured, true);
});

test("no secret value appears in any reply", async () => {
  for (const path of ["/api/health", "/api/state", "/"]) {
    const { text } = await call(path);
    for (const value of Object.values(FAKE)) assert.ok(!text.includes(value), `a secret value is in ${path}`);
  }
});

test("GET / serves the page with AG Grid pinned to 36.2.0", async () => {
  const res = await call("/");
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.match(res.text, /ag-grid-community@36\.2\.0\/dist\/ag-grid-community\.min\.js/);
  assert.match(res.text, /integrity="sha384-/);
});

test("unknown route -> 404 JSON", async () => {
  const res = await call("/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.text), { error: "Not found." });
});

test("broken JSON -> 400 JSON with a plain message (no stack trace)", async () => {
  const res = await call("/api/health", { method: "POST", headers: JSON_HEADERS, body: "{ not json" });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), { error: "The request body is not valid JSON." });
});

test("a body over 100 KB -> 413 JSON", async () => {
  const body = JSON.stringify({ text: "x".repeat(200_000) });
  const res = await call("/api/health", { method: "POST", headers: JSON_HEADERS, body });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.text), { error: "The request is too big (max 100 KB)." });
});

test("each API request logs one line: method, path, status, time in ms", async () => {
  logs.length = 0;
  await call("/api/health?debug=1");
  await new Promise((resolve) => setImmediate(resolve)); // let the server finish logging
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^GET \/api\/health 200 \d+ms$/);
});

test("a crash becomes a generic 500 reply; the details go to the server log only", () => {
  const logged = [];
  let reply;
  const res = {
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      reply = body;
    },
  };
  const handle = errorHandler((line) => logged.push(line));
  handle(new Error("internal detail"), { method: "GET", originalUrl: "/api/x" }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(reply, { error: "Something went wrong on the server. Please try again." });
  assert.match(logged[0], /internal detail/);
});
