// The seller's menu (7 Nov, "My menu"): the demo bakery menu in data/menu.json, and the changes to a visitor's own
// copy of it. The checks for one item live in public/menu-rules.js, so the page runs the very same ones first.
// Pure, apart from loadDemoMenu(): no network, no clock.
// - The golden rule stays: every price comes from the menu, never the AI. A price is typed as text ("25" or
//   "25.50"), read straight into whole sen (no floats), and kept as "25.50", the form all the money code reads.
// - Names and other names are untrusted text, like a buyer's note: hidden characters go, runs of space become
//   one (so a name stays on its own line in the AI's prompt), and every page shows them with textContent. They
//   are never HTML. In the CSV the formula guard (public/csv-safe.js) covers them like every other cell.
// - "Other names" are the words buyers use in chats ("pz", "pepperoni"). The name and each other name become the
//   item's aliases (the words the AI is told, and the no-AI reader matches), with a simple plural or singular.
// - The currency stays the menu's setting: a visitor can't change it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkMenu } from "./orders.js";
import { MENU_LIMITS, readItem, readMenuPrice, textLength, tidy } from "../public/menu-rules.js";

const DEMO_FILE = new URL("../data/menu.json", import.meta.url);

export { MENU_LIMITS, matchWords, readMenuPrice } from "../public/menu-rules.js";
export const MENU_LOCKED = "Invoices are sent for this batch. Start a New batch to change your menu.";

// The demo bakery menu, checked once. A bad file stops the server with a clear message (as before 7 Nov).
export function loadDemoMenu() {
  let menu;
  try {
    menu = JSON.parse(readFileSync(DEMO_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Could not read data/menu.json: ${err.message}`);
  }
  const problems = checkMenu(menu);
  if (problems.length) throw new Error(`data/menu.json has problems: ${problems.join(" ")}`);
  return menu;
}

const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Which items an ambiguous word list ("brownies") can mean: the items with an alias holding one of its words.
function meanings(entry, menu) {
  const words = entry.words.map(cleanWords).filter(Boolean);
  return menu.items
    .filter((item) => item.aliases.some((alias) => words.some((word) => ` ${cleanWords(alias)} `.includes(` ${word} `))))
    .map((item) => item.id).sort().join(" ");
}

// The demo's "Which brownies: classic or cheese?" stays only while it still means the same 2+ items. Once an
// item is added, removed or renamed so that it would mean something else, it goes: an order with plain
// "brownies" then gets the general "no menu item" check, never a question naming the wrong choices.
function keepAmbiguous(next, before) {
  if (!Array.isArray(before.ambiguous)) return next;
  const ambiguous = before.ambiguous.filter((entry) => {
    const now = meanings(entry, next);
    return now === meanings(entry, before) && now.split(" ").length >= 2;
  });
  return { ...next, ambiguous };
}

// A new item -> { menu, item } or { error }. newId() makes its id (random, so an old row can never pick up a
// different item that later got a removed item's id).
export function addMenuItem(menu, body, { newId }) {
  if (menu.items.length >= MENU_LIMITS.maxItems) return { error: `A menu can have at most ${MENU_LIMITS.maxItems} items. Remove one first.` };
  const read = readItem(body, menu.items);
  if (read.error) return { error: read.error };
  const item = { id: newId(), ...read };
  return { menu: keepAmbiguous({ ...menu, items: [...menu.items, item] }, menu), item };
}

// A changed item (same id, same place, same icon) -> { menu, item }, { error } or { missing: true }.
export function editMenuItem(menu, id, body) {
  const at = menu.items.findIndex((item) => item.id === id);
  if (at < 0) return { missing: true };
  const read = readItem(body, menu.items.filter((item) => item.id !== id));
  if (read.error) return { error: read.error };
  const item = { ...menu.items[at], ...read };
  const items = menu.items.map((old, i) => (i === at ? item : old));
  return { menu: keepAmbiguous({ ...menu, items }, menu), item };
}

// -> { menu }, { error } (the last item) or { missing: true }.
export function removeMenuItem(menu, id) {
  if (!menu.items.some((item) => item.id === id)) return { missing: true };
  if (menu.items.length <= 1) return { error: "A menu needs at least one item. Add another item first." };
  return { menu: keepAmbiguous({ ...menu, items: menu.items.filter((item) => item.id !== id) }, menu) };
}

// What the AI and our checks read from a menu, in a fixed order: the currency, the seller's name, and per item
// its id, name, price, aliases and add-on flag; the ambiguous words. An icon or the other names as typed (they
// are in the aliases already) don't change how chats are read, and neither does the order of keys in the file.
export function menuFingerprint(menu) {
  return JSON.stringify([
    menu.currency, menu.sellerName ?? null,
    menu.items.map((item) => [item.id, item.name, item.price, item.aliases, item.addon === true]),
    (menu.ambiguous ?? []).map((entry) => [entry.words, entry.reason]),
  ]);
}
export const menuHash = (menu) => createHash("sha256").update(menuFingerprint(menu)).digest("hex");
export const sameMenu = (a, b) => menuFingerprint(a) === menuFingerprint(b);

// A visitor's saved menu, read back from their file: menu.json's checks plus the editor's limits, and the same
// currency and seller name as the demo (the visitor can't change those). [] = all good.
export function checkSavedMenu(menu, demo = loadDemoMenu()) {
  if (!menu || typeof menu !== "object" || Array.isArray(menu)) return ["The saved menu is not a menu."];
  const problems = checkMenu(menu);
  if (problems.length) return problems;
  if (menu.currency !== demo.currency || menu.sellerName !== demo.sellerName) problems.push("The saved menu has another currency or seller.");
  if (menu.items.length < 1 || menu.items.length > MENU_LIMITS.maxItems) problems.push(`A menu has 1 to ${MENU_LIMITS.maxItems} items.`);
  for (const item of menu.items) {
    const price = readMenuPrice(item.price);
    if (price.error || price.price !== item.price) problems.push(`${JSON.stringify(item.id)} has a bad price.`);
    if (textLength(item.name) > MENU_LIMITS.nameMax || tidy(item.name) !== item.name) problems.push(`${JSON.stringify(item.id)} has a bad name.`);
    if (item.aliases.some((alias) => typeof alias !== "string")) problems.push(`${JSON.stringify(item.id)} has a bad alias.`);
  }
  return problems;
}
