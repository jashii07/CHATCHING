// Paid add-ons (1 Nov): an add-on is an ordinary menu item with "addon": true, listed as its own item with
// its quantity, priced from the menu. Free requests stay in the note. Something the buyer asks for that is
// not on the menu makes the order unclear, in the code's own words. No prices from the AI, no new system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildParsePrompt, parseSchema } from "../src/ai-prompt.js";
import { checkMenu, groupByBuyer, recalcRow, toRows } from "../src/orders.js";
import { fallbackParse } from "../src/fallback-parse.js";
import { splitMessages } from "../src/dates.js";
import { checkOrders } from "../src/validate.js";

const MENU = {
  currency: "USD",
  items: [
    { id: "iced_latte", name: "Iced Latte", price: "5.00", aliases: ["iced latte", "latte"] },
    { id: "oat_milk", name: "Oat Milk", price: "0.80", addon: true, aliases: ["oat milk", "oat"] },
    { id: "extra_shot", name: "Extra Shot", price: "1.00", addon: true, aliases: ["extra shot"] },
  ],
};
const order = (extra = {}) => ({
  buyer: "Ali", status: "active", sourceMsgs: [1], items: [{ itemId: "iced_latte", qty: 1 }],
  deliveryDate: null, fulfilment: null, unclear: false, reason: "", note: "", ...extra,
});
const NOT_ON_MENU = "buyer asked for almond milk, not on the menu.";

test("checkMenu: addon is optional and must be true or false", () => {
  assert.deepEqual(checkMenu(MENU), []);
  const bad = { ...MENU, items: [{ ...MENU.items[1], addon: "yes" }] };
  assert.deepEqual(checkMenu(bad), ['"oat_milk" has a bad addon "yes": use true or false.']);
});

test("the prompt marks only the add-ons, and has the add-on, free-request and not-on-menu rules", () => {
  const { prompt } = buildParsePrompt({ paste: "Ali: 1 iced latte", chatDate: "2026-11-01", menu: MENU });
  assert.ok(prompt.includes('- oat_milk: Oat Milk. Paid add-on. Buyers may write: "oat milk", "oat".'));
  assert.ok(prompt.includes('- iced_latte: Iced Latte. Buyers may write:'));
  assert.match(prompt, /own item with its own quantity/);
  assert.match(prompt, /Free requests .*sugar.*ice.*mayo.* note/);
  assert.match(prompt, /not on the menu.*notOnMenu/);
});

test("the schema reports what is not on the menu as text only, and it is optional", () => {
  const order = parseSchema(MENU).properties.orders.items;
  assert.equal(order.properties.notOnMenu.type, "ARRAY");
  assert.equal(order.properties.notOnMenu.items.type, "STRING");
  assert.ok(!order.required.includes("notOnMenu"));
  assert.ok(order.propertyOrdering.includes("notOnMenu"));
});

test("iced latte with oat milk -> two rows, each priced from the menu", () => {
  const rows = toRows([order({ items: [{ itemId: "iced_latte", qty: 1 }, { itemId: "oat_milk", qty: 1 }] })], MENU);
  assert.deepEqual(rows.map((r) => [r.itemName, r.qty, r.unitPrice, r.lineTotal]), [
    ["Iced Latte", 1, "5.00", "5.00"], ["Oat Milk", 1, "0.80", "0.80"],
  ]);
  assert.equal(groupByBuyer(rows)[0].total, "5.80");
});

test("an add-on keeps its own quantity, and a price from the AI is never used", () => {
  const rows = toRows([order({ items: [{ itemId: "iced_latte", qty: 2 }, { itemId: "oat_milk", qty: 2, price: "0.01" }] })], MENU);
  assert.equal(rows[1].unitPrice, "0.80");
  assert.equal(rows[1].lineTotal, "1.60");
  assert.equal(groupByBuyer(rows)[0].total, "11.60");
});

test("a free request stays in the note: no extra row, the order stays clear", () => {
  const rows = toRows([order({ note: "Less sugar, no ice." })], MENU);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "Less sugar, no ice.");
  assert.equal(rows[0].unclear, false);
});

test("an add-on that is not on the menu -> unclear in the code's exact words, and no invoice", () => {
  const rows = toRows([order({ notOnMenu: ["almond milk"] })], MENU);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unclear, true);
  assert.equal(rows[0].reason, NOT_ON_MENU);
  assert.equal(groupByBuyer(rows)[0].invoiceable, false);
});

test("not on the menu: the AI's unclear flag with no reason adds no vague words; its other reason stays", () => {
  assert.equal(toRows([order({ unclear: true, notOnMenu: ["almond milk"] })], MENU)[0].reason, NOT_ON_MENU);
  assert.equal(toRows([order({ unclear: true, reason: "Which day?", notOnMenu: ["almond milk"] })], MENU)[0].reason, `Which day? ${NOT_ON_MENU}`);
});

test("not on the menu: every name is listed; blanks and non-text are ignored; a cancelled order needs no check", () => {
  const two = toRows([order({ notOnMenu: [" almond milk ", "", null, 5, "syrup"] })], MENU)[0];
  assert.equal(two.reason, `${NOT_ON_MENU} buyer asked for syrup, not on the menu.`);
  assert.equal(toRows([order({ notOnMenu: "almond milk" })], MENU)[0].unclear, false); // not a list: nothing to report
  assert.equal(toRows([order({ status: "cancelled", notOnMenu: ["almond milk"] })], MENU)[0].unclear, false);
});

test("a whole item not on the menu keeps its row with no item, so the seller sees it", () => {
  const rows = toRows([order({ items: [{ itemId: null, qty: 2 }], notOnMenu: ["matcha"], unclear: true })], MENU);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lineTotal, null);
  assert.match(rows[0].reason, /^buyer asked for matcha, not on the menu\./);
});

test("our message checks keep notOnMenu, so the row still gets its reason", () => {
  const messages = splitMessages("[1/11 9:00 AM] Ali: iced latte with almond milk", "2026-11-01");
  const rows = toRows(checkOrders([order({ notOnMenu: ["almond milk"] })], messages), MENU);
  assert.equal(rows[0].reason, NOT_ON_MENU);
});

test("the seller's edit counts as the fix for a not-on-the-menu order", () => {
  const [row] = toRows([order({ notOnMenu: ["almond milk"] })], MENU);
  assert.equal(recalcRow(row, MENU).unclear, false);
});

test("Read without AI never guesses: a drink with an add-on in one phrase is unclear", () => {
  const messages = splitMessages("[1/11 9:00 AM] Ali: 1 iced latte with oat milk", "2026-11-01");
  const [read] = fallbackParse(messages, MENU);
  assert.equal(read.unclear, true);
  assert.equal(groupByBuyer(toRows(read ? [read] : [], MENU))[0].invoiceable, false);
});

test("the demo menu still passes, and has no add-ons to change the demo", () => {
  const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
  assert.deepEqual(checkMenu(menu), []);
  assert.equal(menu.items.filter((item) => item.addon).length, 0);
});
