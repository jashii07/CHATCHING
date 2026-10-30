// Tests for the daily AI call counter (Step 9, src/usage.js): saved in a file, starts again at midnight
// Pacific time, and the reset hour in Malaysia time follows US summer time. A fake clock, no waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsage, nextReset, pacificDay, resetHourMalaysia } from "../src/usage.js";

const MODELS = ["main", "backup"];
const file = () => join(mkdtempSync(join(tmpdir(), "chatching-usage-")), "runtime", "ai-usage.json");
const at = (iso) => () => Date.parse(iso);

test("a fresh counter: 20 per model, 40 together; nothing is written until a call is counted", () => {
  const path = file();
  const usage = createUsage({ file: path, models: MODELS, now: at("2026-10-30T04:00:00Z") });
  assert.deepEqual([usage.left("main"), usage.left("backup"), usage.totalLeft()], [20, 20, 40]);
  assert.equal(existsSync(path), false);
});

test("every counted call is saved at once, so a restart doesn't hand out a fresh 20", () => {
  const path = file();
  const now = at("2026-10-30T04:00:00Z");
  const first = createUsage({ file: path, models: MODELS, now });
  first.take("main");
  first.take("main");
  first.take("backup");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { day: "2026-10-29", calls: { main: 2, backup: 1 } });
  const restarted = createUsage({ file: path, models: MODELS, now });
  assert.deepEqual([restarted.left("main"), restarted.left("backup"), restarted.totalLeft()], [18, 19, 37]);
});

test("never below 0", () => {
  const usage = createUsage({ file: file(), models: MODELS, limit: 1, now: at("2026-10-30T04:00:00Z") });
  usage.take("main");
  usage.take("main");
  assert.equal(usage.left("main"), 0);
  assert.equal(usage.totalLeft(), 1);
});

test("a new Pacific day starts the count again, also after a restart", () => {
  const path = file();
  let t = Date.parse("2026-10-30T06:59:59Z"); // 11:59:59 PM Pacific, Thu 29 Oct
  const usage = createUsage({ file: path, models: MODELS, limit: 2, now: () => t });
  usage.take("main");
  usage.take("main");
  assert.equal(usage.left("main"), 0);
  t = Date.parse("2026-10-30T07:00:00Z"); // midnight Pacific
  assert.equal(usage.left("main"), 2);
  assert.equal(createUsage({ file: path, models: MODELS, limit: 2, now: () => t }).left("main"), 2); // the old day in the file is ignored
});

test("a broken file starts a fresh count with a warning, never a crash", () => {
  const path = file();
  createUsage({ file: path, models: MODELS }).take("main"); // makes the folder
  for (const junk of ["{not json", JSON.stringify({ day: 5 }), JSON.stringify({ day: "2026-10-29", calls: { main: "lots" } })]) {
    writeFileSync(path, junk);
    const logs = [];
    const usage = createUsage({ file: path, models: MODELS, now: at("2026-10-30T04:00:00Z"), log: (line) => logs.push(line) });
    assert.equal(usage.left("main"), 20, junk);
  }
});

test("Pacific day and reset time: midnight Pacific is 3 PM Malaysia time until 1 Nov 2026, then 4 PM", () => {
  assert.equal(pacificDay(Date.parse("2026-10-30T04:00:00Z")), "2026-10-29");
  assert.equal(pacificDay(Date.parse("2026-10-30T07:00:00Z")), "2026-10-30");
  assert.equal(new Date(nextReset(Date.parse("2026-10-30T04:00:00Z"))).toISOString(), "2026-10-30T07:00:00.000Z");
  assert.equal(resetHourMalaysia(Date.parse("2026-10-30T04:00:00Z")), "3 PM");
  // US summer time ends Sun 1 Nov 2026: from then on, midnight Pacific is 08:00 UTC = 4 PM Malaysia time.
  assert.equal(new Date(nextReset(Date.parse("2026-11-01T12:00:00Z"))).toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal(resetHourMalaysia(Date.parse("2026-11-05T04:00:00Z")), "4 PM");
  assert.equal(resetHourMalaysia(Date.parse("2026-12-15T04:00:00Z")), "4 PM"); // judging ends 16 Dec
});

test("useUp (Google said the daily limit is reached): that model is at 0 until the next Pacific day, saved; the other keeps its calls", () => {
  const path = file();
  const time = { t: Date.parse("2026-10-30T04:00:00Z") };
  const usage = createUsage({ file: path, models: MODELS, now: () => time.t });
  usage.take("main");
  usage.useUp("main");
  assert.deepEqual([usage.left("main"), usage.left("backup"), usage.totalLeft()], [0, 20, 20]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { day: "2026-10-29", calls: { main: 20 } });
  time.t = Date.parse("2026-10-30T07:00:00Z"); // midnight Pacific
  assert.equal(usage.left("main"), 20);
});
