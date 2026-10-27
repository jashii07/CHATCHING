// Tests for src/money.js: money is whole cents ("sen" for MYR), never floats,
// and every amount on screen is formatted from menu.json's currency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { toSen, fromSen, formatMoney } from "../src/money.js";

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

// Intl puts a no-break space between "RM" and the number; compare with plain spaces.
const plain = (text) => text.replace(/\u00a0/g, " ");

test("formatMoney uses the currency's symbol: MYR -> RM 54.00, USD -> $54.00", () => {
  assert.equal(plain(formatMoney("54.00", "MYR")), "RM 54.00");
  assert.equal(formatMoney("54.00", "USD"), "$54.00");
  assert.equal(formatMoney("387", "EUR"), "€387.00");
  assert.equal(formatMoney("1234.5", "USD"), "$1,234.50");
});

test("formatMoney refuses a bad amount or currency instead of guessing", () => {
  assert.throws(() => formatMoney("54.001", "USD"), /money/i);
  assert.throws(() => formatMoney(54, "USD"), /money/i);
  assert.throws(() => formatMoney("54.00", "ringgit"), /currency/i);
  assert.throws(() => formatMoney("54.00", undefined), /currency/i);
});

test('no hard-coded "RM" in the app code (src/ and public/): money display comes from menu.json', () => {
  for (const dir of ["../src/", "../public/"]) {
    // Code files only: public/fonts/ holds a font file and its licence, not code.
    for (const file of readdirSync(new URL(dir, import.meta.url)).filter((name) => /\.(js|html|css)$/.test(name))) {
      // Comment lines may show an example ("RM 54.00"); only code counts.
      const code = readFileSync(new URL(dir + file, import.meta.url), "utf8")
        .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      assert.doesNotMatch(code, /\bRM\b/, `${dir}${file}`);
    }
  }
});
