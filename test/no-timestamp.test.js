// A paste with no timestamps (one copied message) must never crash: every message gets the
// Chat date, and no line of the paste is dropped. Fixture: test/fixtures/real-order-no-timestamp.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitMessages } from "../src/dates.js";

const PASTE = readFileSync(new URL("./fixtures/real-order-no-timestamp.txt", import.meta.url), "utf8");
const CHAT_DATE = "2026-10-28";
const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

test("the real-style order with no timestamp -> one message on the Chat date, every line kept", () => {
  const messages = splitMessages(PASTE, CHAT_DATE);
  assert.equal(messages.length, 1);
  for (const message of messages) {
    assert.equal(message.date, CHAT_DATE);
    assert.equal(message.label, "Wed 28 Oct 2026");
    assert.equal(message.warning, "");
    assert.equal(message.reason, "");
  }
  assert.deepEqual(lines(messages.map((m) => m.text).join("\n")), lines(PASTE));
});

test("Windows line endings and blank lines give the same result", () => {
  const messages = splitMessages(`\r\n${PASTE.replace(/\n/g, "\r\n\r\n")}`, CHAT_DATE);
  assert.equal(messages.length, 1);
  assert.deepEqual(lines(messages[0].text), lines(PASTE));
});

test("untimed lines before the first timestamp stay as message 1 on the Chat date", () => {
  const messages = splitMessages(`${PASTE}[28/10 9:02 AM] Lina: make it 2 fried pls`, CHAT_DATE);
  assert.deepEqual(messages.map((m) => [m.n, m.date]), [[1, CHAT_DATE], [2, CHAT_DATE]]);
  assert.equal(messages[1].text, "Lina: make it 2 fried pls");
  assert.equal(messages[1].time, "09:02");
});

test("odd pastes never crash: empty, only spaces, null, a number", () => {
  for (const paste of ["", "   \n\t\n", null, undefined, 42]) {
    assert.doesNotThrow(() => splitMessages(paste, CHAT_DATE));
  }
  assert.deepEqual(splitMessages("", CHAT_DATE), []);
  assert.equal(splitMessages(42, CHAT_DATE)[0].text, "42");
});

test("a bad Chat date is refused with a clear error (the page always sends one)", () => {
  assert.throws(() => splitMessages(PASTE, "28/10/2026"), /Not a valid chat date/);
});

test("the demo chats (one timestamp per line) -> 18 messages, numbered like sourceMsgs", () => {
  const demo = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
  const messages = splitMessages(demo, CHAT_DATE);
  assert.equal(messages.length, 18);
  assert.ok(messages.every((m, i) => m.n === i + 1 && m.date === CHAT_DATE && !m.warning));
  assert.equal(messages[3].text, "Lina: oh wait, make it 3 boxes, my friend wants some too");
});
