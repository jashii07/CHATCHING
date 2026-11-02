// Safety net for every step (MY_RULES.md, "Definition of done").
// Runs all tests, the accuracy check on the saved demo reply (no AI call), then checks that .env and the
// real holdout chats are kept out of git. Run: npm run check
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { testsPassed } from "./crash-reporter.mjs";

const results = [];
const record = (ok, name, detail = "") => results.push({ ok, name, detail });

// 1. All tests in test/ (node:test is built into Node, no package needed). Once in a while Windows Node itself
// crashes in a test file, which says nothing about our code (DECISIONS.md, review #18). Only that file is run
// once more, and the run says so out loud. A test that really fails is never rerun.
const crashLog = join(mkdtempSync(join(tmpdir(), "chatching-check-")), "crashed.txt");
const tests = spawnSync(process.execPath, [
  "--test",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=./scripts/crash-reporter.mjs", `--test-reporter-destination=${crashLog}`,
], { encoding: "utf8" });
process.stdout.write(tests.stdout ?? "");
process.stderr.write(tests.stderr ?? "");
const number = (output, label) => Number(output?.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"))?.[1] ?? NaN);
const crashed = existsSync(crashLog) ? readFileSync(crashLog, "utf8").split(/\r?\n/).filter(Boolean) : [];
const reruns = crashed.map((file) => {
  console.log(`\nNODE CRASHED in ${relative(".", file)} (exit 3221226505), not a test failure. Running that one file once more.`);
  const rerun = spawnSync(process.execPath, ["--test", "--test-reporter=spec", file], { encoding: "utf8" });
  process.stdout.write(rerun.stdout ?? "");
  process.stderr.write(rerun.stderr ?? "");
  return rerun;
});
const testsFailed = number(tests.stdout, "fail");
const ok = testsPassed({ status: tests.status, failed: testsFailed, cancelled: number(tests.stdout, "cancelled"), crashed, reruns: reruns.map((rerun) => rerun.status) });
const passed = reruns.reduce((sum, rerun) => sum + number(rerun.stdout, "pass"), number(tests.stdout, "pass"));
const crashNote = crashed.length ? `; ${crashed.length} file(s) rerun after a Node crash: ${crashed.map((file) => relative(".", file)).join(", ")}` : "";
record(ok, "tests", `${passed} passed, ${ok ? 0 : testsFailed} failed${crashNote}`);

// 2. The saved demo reply still scores perfectly against data/expected-orders.json (0 AI calls).
const accuracy = spawnSync(process.execPath, ["scripts/accuracy.mjs", "--cached"], { encoding: "utf8" });
const accuracyScore = accuracy.stdout?.match(/\*\*Result:\*\* (.*)/)?.[1] ?? accuracy.stdout?.trim().split("\n").at(-1);
record(accuracy.status === 0, "accuracy --cached (demo)", accuracyScore ?? "no output");

// 3. .env must never reach GitHub.
function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.error ? null : result;
}
const tracked = git("ls-files", "--", ".env");
record(tracked?.status === 0 && tracked.stdout.trim() === "", ".env is not tracked by git", tracked ? "" : "git not found");
const ignored = git("check-ignore", "-q", ".env");
record(ignored?.status === 0, ".env is ignored by .gitignore");
const history = git("log", "--all", "--format=%h", "--", ".env");
record(history?.status === 0 && history.stdout.trim() === "", ".env was never committed (whole git history)");

// 4. Real holdout chats (data/holdout/) stay out of git until anonymised and agreed (MY_RULES.md).
const holdoutIgnored = git("check-ignore", "-q", "data/holdout/chats.txt");
record(holdoutIgnored?.status === 0, "data/holdout/ is ignored by .gitignore");
const holdoutTracked = git("ls-files", "--", "data/holdout");
record(holdoutTracked?.status === 0 && holdoutTracked.stdout.trim() === "", "nothing in data/holdout/ is tracked by git");

console.log("\n=== npm run check ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nFAIL: ${failed} of ${results.length} checks failed.` : `\nPASS: all ${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
