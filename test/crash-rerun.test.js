// A test file that Windows Node itself crashed is rerun once by npm run check (DECISIONS.md, review #18). The rule
// must stay narrow: only this exact crash is rerun, and a real test failure is never hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOWS_CRASH, crashedFile, testsPassed } from "../scripts/crash-reporter.mjs";

const fileFailure = (error, nesting = 0) => ({ type: "test:fail", data: { nesting, file: "C:\app\test\api.test.js", details: { error } } });
const crash = { failureType: "testCodeFailure", exitCode: WINDOWS_CRASH };

test("the crash code is 0xC0000409", () => assert.equal(WINDOWS_CRASH, 0xC0000409));

test("a file that died with the crash code is named, wherever Node puts the code", () => {
  assert.equal(crashedFile(fileFailure(crash)), "C:\app\test\api.test.js");
  assert.equal(crashedFile(fileFailure({ failureType: "testCodeFailure", cause: { exitCode: WINDOWS_CRASH } })), "C:\app\test\api.test.js");
});

test("anything else is not a crash: a failed test, another exit code, a passing test, no details", () => {
  assert.equal(crashedFile(fileFailure({ failureType: "subtestsFailed", exitCode: 1 })), null);
  assert.equal(crashedFile(fileFailure({ failureType: "testCodeFailure", exitCode: 1 })), null);
  assert.equal(crashedFile(fileFailure({ failureType: "testCodeFailure" })), null);
  assert.equal(crashedFile(fileFailure(crash, 1)), null, "a test inside a file");
  assert.equal(crashedFile({ type: "test:pass", data: { nesting: 0, file: "x" } }), null);
  assert.equal(crashedFile({ type: "test:fail", data: { nesting: 0, file: "x" } }), null);
});

test("a clean run passes", () => {
  assert.equal(testsPassed({ status: 0, failed: 0, cancelled: 0, crashed: [], reruns: [] }), true);
});

test("a real failure fails, with no rerun", () => {
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 0, crashed: [], reruns: [] }), false);
});

test("one crashed file that passes its rerun passes", () => {
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 0, crashed: ["a"], reruns: [0] }), true);
});

test("a crashed file that fails or crashes again on its rerun fails", () => {
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 0, crashed: ["a"], reruns: [1] }), false);
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 0, crashed: ["a"], reruns: [WINDOWS_CRASH] }), false);
});

test("a crash never hides a real failure in the same run", () => {
  assert.equal(testsPassed({ status: 1, failed: 2, cancelled: 0, crashed: ["a"], reruns: [0] }), false);
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 1, crashed: ["a"], reruns: [0] }), false, "a cancelled test");
});

test("unreadable counts or a missing rerun are a failure, never a pass", () => {
  assert.equal(testsPassed({ status: 1, failed: NaN, cancelled: 0, crashed: ["a"], reruns: [0] }), false);
  assert.equal(testsPassed({ status: 1, failed: 1, cancelled: 0, crashed: ["a"], reruns: [] }), false);
  assert.equal(testsPassed({ status: null, failed: 0, cancelled: 0, crashed: [], reruns: [] }), false);
});
