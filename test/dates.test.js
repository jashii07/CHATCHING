// Tests for src/dates.js: timestamps -> full dates ("nearest date" rule) and day words -> dates.
// Every case runs twice, with the computer's clock faked to 26 Oct 2026 and to December,
// to prove dates.js only uses the chat date and never reads the clock.
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { parseTimestamp, resolveDayWord } from "../src/dates.js";

const WARNING = "Check the Chat date";
const CLOCKS = ["2026-10-26T12:00:00+08:00", "2026-12-15T12:00:00+08:00"];

for (const clock of CLOCKS) {
  describe(`with the clock faked to ${clock}`, () => {
    beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date(clock) }));
    afterEach(() => mock.timers.reset());

    test("the fake clock is on", () => {
      assert.equal(Date.now(), new Date(clock).getTime());
    });

    // PLAN.md Section 6 test table.
    test('2026-10-28 · [28/10] "sabtu" -> 2026-10-31', () => {
      const msg = parseTimestamp("[28/10 9:02 AM]", "2026-10-28");
      assert.equal(msg.date, "2026-10-28");
      assert.equal(resolveDayWord("sabtu", msg.date), "2026-10-31");
    });

    test('2026-10-28 · [28/10] "esok" / "Friday" / "ahad" -> 29 Oct / 30 Oct / 1 Nov', () => {
      const { date } = parseTimestamp("[28/10]", "2026-10-28");
      assert.equal(resolveDayWord("esok", date), "2026-10-29");
      assert.equal(resolveDayWord("Friday", date), "2026-10-30");
      assert.equal(resolveDayWord("ahad", date), "2026-11-01");
    });

    test("2027-01-02 · [31/12] -> 2026-12-31, no warning (2 days before)", () => {
      assert.deepEqual(parseTimestamp("[31/12]", "2027-01-02"),
        { date: "2026-12-31", time: null, label: "Thu 31 Dec 2026", warning: "", reason: "" });
    });

    test("2027-01-02 · [2/1] -> 2027-01-02, no warning", () => {
      const msg = parseTimestamp("[2/1]", "2027-01-02");
      assert.equal(msg.date, "2027-01-02");
      assert.equal(msg.warning, "");
    });

    test(`2026-10-28 · [29/10] (1 day after the chat date) -> 2026-10-29 + "${WARNING}"`, () => {
      const msg = parseTimestamp("[29/10]", "2026-10-28");
      assert.equal(msg.date, "2026-10-29");
      assert.equal(msg.warning, WARNING);
    });

    test(`2026-10-28 · [15/7] (105 days before) -> 2026-07-15 + "${WARNING}"`, () => {
      const msg = parseTimestamp("[15/7]", "2026-10-28");
      assert.equal(msg.date, "2026-07-15");
      assert.equal(msg.warning, WARNING);
    });

    test("2027-03-01 · [29/2] (no 29 Feb in 2027) -> impossible: no date, a reason, no guessing", () => {
      const msg = parseTimestamp("[29/2]", "2027-03-01");
      assert.equal(msg.date, null);
      assert.match(msg.reason, /There is no 29\/2 in 2027/);
    });

    test("2028-03-01 · [29/2] (2028 is a leap year) -> 2028-02-29, no warning", () => {
      const msg = parseTimestamp("[29/2]", "2028-03-01");
      assert.equal(msg.date, "2028-02-29");
      assert.equal(msg.warning, "");
    });
  });
}

describe("parseTimestamp: more cases", () => {
  test("reads the time and gives the full date with its weekday", () => {
    assert.deepEqual(parseTimestamp("[28/10 9:02 AM]", "2026-10-28"),
      { date: "2026-10-28", time: "09:02", label: "Wed 28 Oct 2026", warning: "", reason: "" });
    assert.equal(parseTimestamp("[28/10 12:20 PM]", "2026-10-28").time, "12:20");
    assert.equal(parseTimestamp("[28/10 12:05 am]", "2026-10-28").time, "00:05");
    assert.equal(parseTimestamp("[28/10 9:30 PM]", "2026-10-28").time, "21:30");
    assert.equal(parseTimestamp("[28/10 21:30]", "2026-10-28").time, "21:30");
  });

  test("works on a whole chat line, not just the timestamp", () => {
    assert.equal(parseTimestamp("[28/10 9:02 AM] Lina: kak nak order", "2026-10-28").date, "2026-10-28");
  });

  test("[31/4] -> impossible (April has 30 days)", () => {
    const msg = parseTimestamp("[31/4]", "2026-05-02");
    assert.equal(msg.date, null);
    assert.match(msg.reason, /There is no 31\/4 in 2026/);
  });

  test("month 13 or day 0 -> impossible", () => {
    assert.equal(parseTimestamp("[1/13]", "2026-10-28").date, null);
    assert.equal(parseTimestamp("[0/10]", "2026-10-28").date, null);
  });

  test("60 days before: no warning; 61 days before: warning", () => {
    assert.equal(parseTimestamp("[29/8]", "2026-10-28").warning, "");
    assert.equal(parseTimestamp("[28/8]", "2026-10-28").warning, WARNING);
  });

  test("on a tie the earlier year wins ([1/1] with chat date 2 Jul 2028: 183 days either way)", () => {
    const msg = parseTimestamp("[1/1]", "2028-07-02");
    assert.equal(msg.date, "2028-01-01");
    assert.equal(msg.warning, WARNING);
  });

  test("an unreadable timestamp or time -> no date and a reason", () => {
    for (const bad of ["28/10 9:02 AM", "[yesterday]", "[28/10 13:00 PM]", "[28/10 9:61]", "", null]) {
      const msg = parseTimestamp(bad, "2026-10-28");
      assert.equal(msg.date, null, String(bad));
      assert.match(msg.reason, /Can't read the timestamp/, String(bad));
    }
  });

  test("a bad chat date throws (the route must check it first)", () => {
    for (const bad of ["2026-02-30", "28/10/2026", "", null]) {
      assert.throws(() => parseTimestamp("[28/10]", bad), /chat date/i, String(bad));
    }
  });
});

describe("resolveDayWord: more cases", () => {
  // Wed 28 Oct 2026.
  const wed = "2026-10-28";

  test("every Malay word", () => {
    const expected = { esok: "2026-10-29", lusa: "2026-10-30", isnin: "2026-11-02", selasa: "2026-11-03",
      rabu: "2026-11-04", khamis: "2026-10-29", jumaat: "2026-10-30", sabtu: "2026-10-31", ahad: "2026-11-01" };
    for (const [word, date] of Object.entries(expected)) assert.equal(resolveDayWord(word, wed), date, word);
  });

  test("every English word", () => {
    const expected = { tomorrow: "2026-10-29", monday: "2026-11-02", tuesday: "2026-11-03", wednesday: "2026-11-04",
      thursday: "2026-10-29", friday: "2026-10-30", saturday: "2026-10-31", sunday: "2026-11-01" };
    for (const [word, date] of Object.entries(expected)) assert.equal(resolveDayWord(word, wed), date, word);
  });

  test("the message's own weekday means NEXT week (\"rabu\" on a Wednesday -> 7 days later)", () => {
    assert.equal(resolveDayWord("rabu", wed), "2026-11-04");
  });

  test("capitals and spaces don't matter", () => {
    assert.equal(resolveDayWord("  Sabtu ", wed), "2026-10-31");
    assert.equal(resolveDayWord("SATURDAY", wed), "2026-10-31");
  });

  test("crosses month and year ends", () => {
    assert.equal(resolveDayWord("esok", "2026-12-31"), "2027-01-01");
    assert.equal(resolveDayWord("lusa", "2028-02-28"), "2028-03-01");
  });

  test("an unknown word -> null (no guessing)", () => {
    for (const word of ["petang", "next week", "", null]) assert.equal(resolveDayWord(word, wed), null, String(word));
  });

  test("a bad message date throws", () => {
    assert.throws(() => resolveDayWord("esok", "2026-13-01"), /message date/i);
  });
});
