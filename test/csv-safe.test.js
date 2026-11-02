// CSV formula injection (review #3). A buyer picks their own chat name, and the seller opens the export in
// Excel. A cell starting with = + - @ (or a tab or carriage return) can run as a formula there, so such a
// value gets a leading ' and stays plain text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCell } from "../public/csv-safe.js";

test('a value starting with = + - @ gets a leading \'', () => {
  for (const value of ['=HYPERLINK("//evil.example/x","Click")', "+60123456789", "-2+3", "@SUM(A1:A9)"]) {
    assert.equal(safeCell(value), `'${value}`);
  }
});

test("a value starting with a tab or a carriage return gets a leading ' too", () => {
  assert.equal(safeCell("\t=1+1"), "'\t=1+1");
  assert.equal(safeCell("\r=1+1"), "'\r=1+1");
});

test("ordinary values are left alone, including a character that is only dangerous at the start", () => {
  for (const value of ["Lina", "Kak Ros", "2 x Classic brownies", "1+1 deal", "a=b", "lina@example.com", "54.00", "Sat 31 Oct", "", "— no date", "'quoted"]) {
    assert.equal(safeCell(value), value);
  }
});

test("a number stays a number, so Excel can still add up the totals", () => {
  assert.equal(safeCell(54), 54);
  assert.equal(safeCell(0), 0);
});

test("an empty cell stays empty", () => {
  assert.equal(safeCell(null), null);
  assert.equal(safeCell(undefined), undefined);
});
