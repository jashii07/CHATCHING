// Tests for src/money.js: money is whole sen (1 RM = 100 sen), never floats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSen, fromSen } from "../src/money.js";

test("toSen turns a price string into whole sen", () => {
  assert.equal(toSen("18.00"), 1800);
  assert.equal(toSen("0.05"), 5);
  assert.equal(toSen("45"), 4500);
  assert.equal(toSen("18.5"), 1850);
});

test("fromSen turns whole sen back into a 2-decimal string", () => {
  assert.equal(fromSen(1800), "18.00");
  assert.equal(fromSen(5), "0.05");
  assert.equal(fromSen(0), "0.00");
  assert.equal(fromSen(38700), "387.00");
});

test("adding in sen has no float rounding errors (0.10 + 0.20 = 0.30)", () => {
  assert.equal(0.1 + 0.2 === 0.3, false); // the float problem we avoid
  assert.equal(fromSen(toSen("0.10") + toSen("0.20")), "0.30");
});

test("bad money input throws instead of guessing", () => {
  for (const bad of ["abc", "", "18.005", "-1.00", "1,000.00", 18, null, undefined]) {
    assert.throws(() => toSen(bad), /money/i, `toSen(${JSON.stringify(bad)})`);
  }
  for (const bad of [18.5, -1, NaN, "1800", null]) {
    assert.throws(() => fromSen(bad), /sen/i, `fromSen(${JSON.stringify(bad)})`);
  }
});
