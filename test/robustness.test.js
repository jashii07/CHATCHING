// Robustness check on money.js, orders.js and dates.js (26 Oct): edge cases, a property check and a fuzz check.
// Tests marked { todo: true } FAIL today on purpose: they show a known gap, waiting for Jasper's decision.
// Random tests use a fixed seed, so a failure always repeats the same way.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toSen, fromSen } from "../src/money.js";
import { toRows, groupByBuyer, totals, mapPayPalStatus } from "../src/orders.js";
import { parseTimestamp, resolveDayWord } from "../src/dates.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const CHAT = "2026-10-28";
const ids = menu.items.map((i) => i.id);
const order = (buyer, extra = {}) => ({ buyer, status: "active", items: [{ itemId: "cookies", qty: 1 }], ...extra });

// Small seeded random number generator (mulberry32), so random tests repeat exactly.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("1a. paste formats", () => {
  test('iPhone style "[28/10/2026, 9:02:15 AM]" (year + seconds + comma) -> 28 Oct, 09:02', { todo: true }, () => {
    const msg = parseTimestamp("[28/10/2026, 9:02:15 AM] Lina: kak nak order", CHAT);
    assert.equal(msg.date, "2026-10-28");
    assert.equal(msg.time, "09:02");
  });

  test('a comma after the date, lowercase am: "[28/10, 9:02 am]"', { todo: true }, () => {
    assert.equal(parseTimestamp("[28/10, 9:02 am] Lina: hi", CHAT).date, "2026-10-28");
  });

  test('Android style with no brackets: "28/10/26, 9:02 am - Lina: hi"', { todo: true }, () => {
    assert.equal(parseTimestamp("28/10/26, 9:02 am - Lina: hi", CHAT).date, "2026-10-28");
  });

  test("an invisible left-to-right mark before the [ (some phone exports add one)", { todo: true }, () => {
    assert.equal(parseTimestamp("‎[28/10 9:02 AM] Lina: hi", CHAT).date, "2026-10-28");
  });

  test("a narrow no-break space before AM (newer phone exports) is read", () => {
    assert.equal(parseTimestamp("[28/10 9:02 AM] Lina: hi", CHAT).time, "09:02");
  });

  test('24-hour "[28/10 21:30]" -> 21:30', () => {
    assert.equal(parseTimestamp("[28/10 21:30] Lina: hi", CHAT).time, "21:30");
  });

  test('"12:30 AM" -> 00:30 and "12:30 PM" -> 12:30', () => {
    assert.equal(parseTimestamp("[28/10 12:30 AM]", CHAT).time, "00:30");
    assert.equal(parseTimestamp("[28/10 12:30 PM]", CHAT).time, "12:30");
  });

  test("a message that continues on a second line: the first line gives the date", () => {
    assert.equal(parseTimestamp("[28/10 9:02 AM] Lina: kak nak order\n2 kotak brownies classic", CHAT).date, "2026-10-28");
  });

  test("the second line on its own (no timestamp) -> no date + a reason, no crash", () => {
    const msg = parseTimestamp("2 kotak brownies classic", CHAT);
    assert.equal(msg.date, null);
    assert.match(msg.reason, /Can't read the timestamp/);
  });

  test("a line with no timestamp at all -> no date + a reason, no crash", () => {
    const msg = parseTimestamp("Lina: kak nak order", CHAT);
    assert.equal(msg.date, null);
    assert.ok(msg.reason);
  });

  test("US order [10/28] is impossible as day/month -> unclear, not guessed", () => {
    assert.equal(parseTimestamp("[10/28]", CHAT).date, null);
  });
});

describe("1b. buyer names", () => {
  const groups = (...names) => groupByBuyer(toRows(names.map((n) => order(n)), menu)).map((g) => g.buyer);

  test('"Lina" and " Lina " -> one buyer (spaces are trimmed)', () => {
    assert.deepEqual(groups("Lina", " Lina "), ["Lina"]);
  });

  test('"Lina" and "lina" -> one buyer (today: 2 buyers, so 2 invoices)', { todo: true }, () => {
    assert.equal(groups("Lina", "lina").length, 1);
  });

  test('"Kak Lina" and "Lina" stay 2 buyers (observed; could be 2 different people)', () => {
    assert.deepEqual(groups("Kak Lina", "Lina"), ["Kak Lina", "Lina"]);
  });

  test('emoji in a name ("Lina 🌸") is kept and groups normally', () => {
    assert.deepEqual(groups("Lina 🌸", "Lina 🌸"), ["Lina 🌸"]);
  });

  test("a 500-character buyer name -> the row is kept, not dropped", () => {
    const rows = toRows([order("x".repeat(500))], menu);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].buyer.length, 500);
  });

  test("a buyer name over 100 characters is flagged unclear (suggested limit)", { todo: true }, () => {
    assert.equal(toRows([order("x".repeat(500))], menu)[0].unclear, true);
  });
});

describe("1c. broken AI output", () => {
  test("an empty order {} -> one unclear row naming every problem", () => {
    const [row] = toRows([{}], menu);
    assert.equal(row.unclear, true);
    assert.match(row.reason, /Buyer name missing.*No menu item.*Quantity missing/);
  });

  test("null everywhere at order level -> one unclear row, no crash", () => {
    const nulls = { buyer: null, status: null, items: null, deliveryDate: null, fulfilment: null,
      unclear: null, reason: null, note: null, sourceMsgs: null };
    for (const o of [null, undefined, nulls]) {
      const rows = toRows([o], menu);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].unclear, true);
    }
  });

  test("a null or missing entry INSIDE items -> unclear row, no crash", { todo: true }, () => {
    for (const items of [[null], [undefined], [null, { itemId: "cookies", qty: 1 }]]) {
      const rows = toRows([order("Ali", { items })], menu);
      assert.equal(rows.length, items.length);
      assert.equal(rows[0].unclear, true);
    }
  });

  test('qty as the string "3" -> unclear (not silently turned into 3)', () => {
    const [row] = toRows([order("Ali", { items: [{ itemId: "cookies", qty: "3" }] })], menu);
    assert.equal(row.unclear, true);
    assert.equal(row.lineTotal, null);
  });

  test("negative qty -> unclear", () => {
    assert.equal(toRows([order("Ali", { items: [{ itemId: "cookies", qty: -2 }] })], menu)[0].unclear, true);
  });

  test("the qty reason shows the real bad value (NaN, Infinity), not \"null\"", { todo: true }, () => {
    for (const qty of [NaN, Infinity]) {
      const [row] = toRows([order("Ali", { items: [{ itemId: "cookies", qty }] })], menu);
      assert.match(row.reason, new RegExp(String(qty)));
    }
  });

  test("a note or reason that isn't text still gives a text note and reason", { todo: true }, () => {
    const [row] = toRows([order("Ali", { note: { x: 1 }, unclear: true, reason: { y: 2 } })], menu);
    assert.equal(typeof row.note, "string");
    assert.doesNotMatch(row.reason, /object Object/);
  });

  test("toRows(not an array) throws a clear error (by design; the route must catch it)", () => {
    assert.throws(() => toRows(null, menu), /aiOrders must be an array/);
  });

  test('mapPayPalStatus("__proto__" / "constructor") still returns text', { todo: true }, () => {
    for (const s of ["__proto__", "constructor"]) assert.equal(typeof mapPayPalStatus(s), "string", s);
  });

  test('resolveDayWord("__proto__" / "constructor") -> null, no crash', { todo: true }, () => {
    for (const w of ["__proto__", "constructor"]) assert.equal(resolveDayWord(w, CHAT), null, w);
  });
});

describe("1d. dates", () => {
  test('year change: chat date 2 Jan 2027, [31/12] "esok" -> 1 Jan 2027', () => {
    const msg = parseTimestamp("[31/12 11:50 PM] Lina: esok boleh?", "2027-01-02");
    assert.equal(msg.date, "2026-12-31");
    assert.equal(resolveDayWord("esok", msg.date), "2027-01-01");
  });

  test("29 Feb: esok after 28 Feb 2028 is 29 Feb; esok after 29 Feb is 1 Mar", () => {
    assert.equal(resolveDayWord("esok", "2028-02-28"), "2028-02-29");
    assert.equal(resolveDayWord("esok", "2028-02-29"), "2028-03-01");
    assert.equal(parseTimestamp("[29/2]", "2028-02-29").warning, "");
  });

  test('"esok" on 31 Oct -> 1 Nov', () => {
    assert.equal(resolveDayWord("esok", "2026-10-31"), "2026-11-01");
  });
});

// Random VALID AI output: known items, qty 1-99, a few cancelled or AI-flagged orders.
function validOutput(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const buyers = ["Lina", "Hafiz", "Mei Ling", "Arif", "Priya", "Sarah", "Kak Ros", "Jun Wei"];
  return Array.from({ length: 1 + Math.floor(rand() * 12) }, () => {
    const flagged = rand() < 0.1;
    return {
      buyer: pick(buyers), status: rand() < 0.1 ? "cancelled" : "active", sourceMsgs: [1],
      items: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({ itemId: pick(ids), qty: 1 + Math.floor(rand() * 99) })),
      deliveryDate: CHAT, fulfilment: null, unclear: flagged, reason: flagged ? "AI not sure." : "", note: "",
    };
  });
}

describe("2. property check: 1000 random valid AI outputs", () => {
  test("no row disappears, money is whole sen, line totals = price × qty, the total = sum of line totals", () => {
    const rand = seeded(20261026);
    const priceSen = Object.fromEntries(menu.items.map((i) => [i.id, toSen(i.price)]));
    for (let run = 0; run < 1000; run++) {
      const orders = validOutput(rand);
      const rows = toRows(orders, menu);
      const where = `run ${run}`;

      assert.equal(rows.length, orders.reduce((n, o) => n + o.items.length, 0), `${where}: row count = item count`);
      for (const row of rows) {
        assert.match(row.lineTotal, /^\d+\.\d{2}$/, where);
        assert.ok(Number.isSafeInteger(toSen(row.lineTotal)), where);
        assert.equal(toSen(row.lineTotal), priceSen[row.itemId] * row.qty, `${where}: line total = menu price × qty`);
      }

      // Independent answer worked out from the INPUT, not with groupByBuyer:
      // a buyer counts when none of their active orders is flagged; their total is price × qty of active items.
      const byBuyer = new Map();
      for (const o of orders.filter((o) => o.status === "active")) {
        const b = byBuyer.get(o.buyer) ?? { ok: true, sen: 0 };
        b.ok &&= !o.unclear;
        b.sen += o.items.reduce((s, i) => s + priceSen[i.itemId] * i.qty, 0);
        byBuyer.set(o.buyer, b);
      }
      const ready = [...byBuyer.values()].filter((b) => b.ok);
      assert.deepEqual(totals(rows), { orders: ready.length, total: fromSen(ready.reduce((s, b) => s + b.sen, 0)) }, where);

      for (const group of groupByBuyer(rows).filter((g) => g.invoiceable)) {
        assert.equal(toSen(group.total), group.rows.reduce((s, r) => s + toSen(r.lineTotal), 0), `${where}: ${group.buyer}`);
      }
    }
  });
});

// Random BROKEN AI output: every field can be missing, null, the wrong type or out of range.
function brokenOutput(rand, { nullItemEntries }) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const item = () => ({
    itemId: pick([undefined, null, "", 42, "pizza", "__proto__", "Cookies", ...ids]),
    qty: pick([undefined, null, 0, -1, 100, 2.5, "3", NaN, Infinity, 1e21, true, 1, 3, 99]),
  });
  const entries = () => {
    const list = Array.from({ length: Math.floor(rand() * 4) }, item);
    if (nullItemEntries && rand() < 0.3) list.push(pick([null, undefined]));
    return list;
  };
  return Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick([null, undefined, {
    buyer: pick([undefined, null, "", "   ", 42, {}, "x".repeat(500), "Lina 🌸", "Lina", "lina"]),
    status: pick([undefined, null, "active", "cancelled", "CANCELLED", 7]),
    items: pick([undefined, null, "abc", {}, [], entries(), entries()]),
    unclear: pick([undefined, null, true, false, "yes", 0]),
    reason: pick([undefined, null, "", "AI not sure.", 42]),
    deliveryDate: pick([undefined, null, "2026-10-31", "tomorrow", 5]),
    sourceMsgs: pick([undefined, null, [1], "x"]),
    note: pick([undefined, null, "", "ok"]),
  }]));
}

function checkBroken(orders) {
  const rows = toRows(orders, menu);
  const expectedRows = orders.reduce((n, o) => n + (Array.isArray(o?.items) && o.items.length ? o.items.length : 1), 0);
  assert.equal(rows.length, expectedRows, "row count = item count (an order with no items gives 1 row)");

  let r = 0;
  for (const o of orders) {
    const items = Array.isArray(o?.items) && o.items.length ? o.items : [null];
    for (const it of items) {
      const row = rows[r++];
      if (o?.status === "cancelled") continue; // cancelled rows are never "unclear", by design
      const bad = !ids.includes(it?.itemId) || !(Number.isInteger(it?.qty) && it.qty >= 1 && it.qty <= 99)
        || !(typeof o?.buyer === "string" && o.buyer.trim()) || Boolean(o?.unclear);
      assert.equal(row.unclear, bad, `row ${row.id}: unclear should be ${bad} (${JSON.stringify({ o, it })})`);
      if (bad) assert.ok(typeof row.reason === "string" && row.reason.length > 0, `row ${row.id}: needs a reason`);
      else assert.ok(row.lineTotal, `row ${row.id}: a clear row has a line total`);
    }
  }
}

describe("3. fuzz check: 200 random broken AI outputs", () => {
  test("toRows never throws, and every bad row is unclear with a reason (incl. null entries inside items)", { todo: true }, () => {
    const rand = seeded(42);
    const crashes = [];
    for (let run = 0; run < 200; run++) {
      const orders = brokenOutput(rand, { nullItemEntries: true });
      try { checkBroken(orders); } catch (e) { crashes.push(`run ${run}: ${e.message.split("\n")[0]}`); }
    }
    assert.deepEqual(crashes, [], `${crashes.length}/200 failed, e.g. ${crashes[0]}`);
  });

  test("same check WITHOUT null entries inside items (guards everything else today)", () => {
    const rand = seeded(42);
    for (let run = 0; run < 200; run++) checkBroken(brokenOutput(rand, { nullItemEntries: false }));
  });
});
