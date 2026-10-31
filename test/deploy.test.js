// Tests for running on Render's free plan (Step 11): settings come from the environment (no .env file),
// and the disk is empty after every restart or sleep (data/runtime/ is gone), so the app must start
// cleanly from nothing. Temporary folders only; never the real data/runtime/ or .env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi } from "../src/ai.js";
import { createUsage } from "../src/usage.js";
import { MAIN_MODEL, BACKUP_MODEL } from "../src/gemini.js";

const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");

test("on Render (RENDER and PORT set by Render): listen on 0.0.0.0 and Render's port", () => {
  const config = loadConfig({ RENDER: "true", PORT: "10000" });
  assert.deepEqual([config.onRender, config.host, config.port], [true, "0.0.0.0", 10000]);
  const local = loadConfig({});
  assert.deepEqual([local.onRender, local.host, local.port], [false, undefined, 3000]);
});

test("package.json: Node 24 and only express + the QR maker at runtime (Render installs with npm ci --omit=dev)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, "24.x");
  assert.deepEqual(pkg.dependencies, { express: "5.3.0", "qrcode-generator": "2.0.4" }); // exact versions, no ^
  assert.equal(pkg.scripts.start, "node --env-file-if-exists=.env server.js"); // works with no .env file
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages[""].dependencies.express, pkg.dependencies.express, "the lock file matches package.json");
});

test("a fresh disk (no data/runtime/ at all): the app starts with an empty table and a full AI count, and reads the demo with 0 calls", async (t) => {
  const runtime = join(mkdtempSync(join(tmpdir(), "chatching-fresh-")), "runtime"); // does not exist yet
  const calls = [];
  const fakeGemini = async (url) => (calls.push(url), new Response("{}", { status: 500 }));
  const usage = createUsage({ file: join(runtime, "ai-usage.json"), models: [MAIN_MODEL, BACKUP_MODEL], log: () => {} });
  const ai = createAi({ mode: "real", apiKey: "fake-gemini-789", fetch: fakeGemini, cacheDir: join(runtime, "ai-cache"), usage, log: () => {} });
  const logs = [];
  const app = createApp(loadConfig({ RENDER: "true", AI_MODE: "real", GEMINI_API_KEY: "fake-gemini-789" }), {
    log: (line) => logs.push(line), visitorsDir: join(runtime, "visitors"), ai,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => (server.closeAllConnections(), server.close()));
  const base = `http://localhost:${server.address().port}`;

  const first = await fetch(`${base}/api/state`);
  const state = await first.json();
  assert.deepEqual(state.orders, [], "a new visitor starts empty");
  assert.equal(state.aiCallsLeft, 40);
  assert.ok(!existsSync(join(runtime, "visitors")), "nothing to save yet, so the folder is not made");
  assert.ok(logs.every((line) => !/Warning/.test(line)), `no warnings on a fresh start: ${logs.join(" | ")}`);

  const cookie = first.headers.getSetCookie()[0].split(";")[0];
  const res = await fetch(`${base}/api/parse`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ text: DEMO, chatDate: "2026-10-28" }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).orders.length, 12);
  assert.ok(existsSync(join(runtime, "visitors", `${cookie.split("=")[1]}.json`)), "the folder and the file are made on the first save");
  assert.equal(calls.length, 0, "the demo comes from the saved reply that ships with the app");
});
