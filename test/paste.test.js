// Tests for reading a paste (Step 4, Part 1): phone timestamp formats in a whole paste, lines that
// continue a message, and the input limits (120 messages / 15,000 characters -> a friendly notice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitMessages } from "../src/dates.js";
import { readPaste, MAX_MESSAGES, MAX_CHARS } from "../src/paste.js";

const CHAT = "2026-10-28";
const FIXTURE = readFileSync(new URL("./fixtures/real-order-no-timestamp.txt", import.meta.url), "utf8");
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const pick = (messages) => messages.map((m) => [m.n, m.date, m.time, m.text]);

test("each phone format starts a new message; the text keeps only what comes after the timestamp", () => {
  const paste = [
    "[28/10/2026, 9:02:15 AM] Lina: hi (iPhone)",
    "[28/10, 9:05 am] Hafiz: hi (comma, lowercase)",
    "28/10/26, 9:10 am - Mei Ling: hi (Android)",
    "[9:15 am, 28/10/2026] Arif: hi (web, time first)",
    "‎[28/10 9:20 AM] Priya: hi (invisible mark)",
    "[28/10 9:25 PM] Sarah: hi (narrow space)",
  ].join("\n");
  assert.deepEqual(pick(splitMessages(paste, CHAT)), [
    [1, CHAT, "09:02", "Lina: hi (iPhone)"],
    [2, CHAT, "09:05", "Hafiz: hi (comma, lowercase)"],
    [3, CHAT, "09:10", "Mei Ling: hi (Android)"],
    [4, CHAT, "09:15", "Arif: hi (web, time first)"],
    [5, CHAT, "09:20", "Priya: hi (invisible mark)"],
    [6, CHAT, "21:25", "Sarah: hi (narrow space)"],
  ]);
});

test("Android: a line with no timestamp continues the message above it", () => {
  const messages = splitMessages("28/10/26, 9:02 am - Lina: can i order\n2 boxes classic\n28/10/26, 9:05 am - Lina: thanks", CHAT);
  assert.deepEqual(pick(messages), [
    [1, CHAT, "09:02", "Lina: can i order\n2 boxes classic"],
    [2, CHAT, "09:05", "Lina: thanks"],
  ]);
});

test("a date-like line that is NOT an Android timestamp stays part of the message (\"28/10 delivery pls\")", () => {
  const messages = splitMessages("[28/10 9:02 AM] Lina: hi\n28/10 delivery pls\n2/3 boxes", CHAT);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Lina: hi\n28/10 delivery pls\n2/3 boxes");
});

test("a stamp with a year uses that year (no guessing), and still warns when far from the Chat date", () => {
  const [msg] = splitMessages("[28/10/2025, 9:02 AM] Lina: hi", CHAT);
  assert.equal(msg.date, "2025-10-28");
  assert.equal(msg.warning, "Check the Chat date");
});

test("an impossible date with a year (29/2/2027) -> no date + a reason, never guessed", () => {
  const [msg] = splitMessages("[29/2/2027, 9:02 AM] Lina: hi", "2027-03-01");
  assert.equal(msg.date, null);
  assert.match(msg.reason, /no 29\/2 in 2027/);
});

test("a bracketed stamp we can't read still starts a message, with a reason (\"[28/10 25:00]\")", () => {
  const messages = splitMessages("[28/10 9:02 AM] Lina: hi\n[28/10 25:00] Lina: bye", CHAT);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].date, null);
  assert.match(messages[1].reason, /Can't read the timestamp/);
  assert.equal(messages[1].text, "Lina: bye");
});

test("readPaste: the demo chats -> 18 messages, no notice", () => {
  const { messages, notice } = readPaste(DEMO, CHAT);
  assert.equal(notice, "");
  assert.equal(messages.length, 18);
});

test("readPaste: the real-style order with no timestamp -> one message on the Chat date", () => {
  const { messages, notice } = readPaste(FIXTURE, CHAT);
  assert.equal(notice, "");
  assert.deepEqual(messages.map((m) => [m.n, m.date]), [[1, CHAT]]);
});

test("readPaste: an empty paste or a missing Chat date -> a friendly notice, no crash", () => {
  for (const text of ["", "   \n\t", null, undefined, 42]) {
    assert.match(readPaste(text, CHAT).notice, /Paste some chat messages first/);
  }
  for (const date of ["", null, "28/10/2026", "2026-02-30"]) {
    assert.match(readPaste(DEMO, date).notice, /Choose the Chat date/);
  }
});

test(`readPaste: exactly ${MAX_MESSAGES} messages is fine; ${MAX_MESSAGES + 1} -> a friendly notice`, () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `[28/10 9:${String(i % 60).padStart(2, "0")} AM] Buyer ${i}: 1 cookies`).join("\n");
  assert.equal(readPaste(lines(MAX_MESSAGES), CHAT).notice, "");
  const { messages, notice } = readPaste(lines(MAX_MESSAGES + 1), CHAT);
  assert.equal(messages, undefined);
  assert.equal(notice, "That's 121 messages. ChatChing reads up to 120 at a time, so please paste fewer.");
});

test(`readPaste: exactly ${MAX_CHARS.toLocaleString("en")} characters is fine; one more -> a friendly notice`, () => {
  const text = (n) => `[28/10 9:02 AM] Lina: ${"x".repeat(n - 22)}`;
  assert.equal(text(MAX_CHARS).length, MAX_CHARS);
  assert.equal(readPaste(text(MAX_CHARS), CHAT).notice, "");
  assert.equal(readPaste(text(MAX_CHARS + 1), CHAT).notice,
    "That paste is 15,001 characters. ChatChing reads up to 15,000 at a time, so please paste fewer messages.");
});

test("the page checks the same character limit as the server, so a long paste is never refused by one and not the other", () => {
  const page = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(page, new RegExp(`const MAX_CHARS = ${String(MAX_CHARS).replace(/(\d{3})$/, "_$1")};`));
});

test("a whole day with the seller's replies fits: 93 messages for 10 orders is read", () => {
  const day = Array.from({ length: 93 }, (_, i) => `[28/10 9:${String(i % 60).padStart(2, "0")} AM] ${i % 2 ? "Seller" : "Lina"}: 1 cookies`).join("\n");
  const { messages, notice } = readPaste(day, CHAT);
  assert.equal(notice, "");
  assert.equal(messages.length, 93);
});

test("readPaste: a huge paste (1 MB) is refused quickly, without splitting it", () => {
  const start = performance.now();
  assert.match(readPaste("x".repeat(1_000_000), CHAT).notice, /1,000,000 characters/);
  assert.ok(performance.now() - start < 50);
});
