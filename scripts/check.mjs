// Safety net for every step (MY_RULES.md, "Definition of done").
// Runs all tests, then checks that .env is kept out of git. Run: npm run check
import { spawnSync } from "node:child_process";

const results = [];
const record = (ok, name, detail = "") => results.push({ ok, name, detail });

// 1. All tests in test/ (node:test is built into Node, no package needed).
const tests = spawnSync(process.execPath, ["--test", "--test-reporter=spec"], { encoding: "utf8" });
process.stdout.write(tests.stdout ?? "");
process.stderr.write(tests.stderr ?? "");
const count = (label) => tests.stdout?.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"))?.[1] ?? "?";
record(tests.status === 0, "tests", `${count("pass")} passed, ${count("fail")} failed`);

// 2. .env must never reach GitHub.
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

console.log("\n=== npm run check ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nFAIL: ${failed} of ${results.length} checks failed.` : `\nPASS: all ${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
