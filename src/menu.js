// The seller's menu (7 Nov, "My menu"): the demo bakery menu in data/menu.json, and the checks and changes for a
// visitor's own copy of it. Pure, apart from loadDemoMenu(): no network, no clock.
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
import { fromSen } from "./money.js";

const DEMO_FILE = new URL("../data/menu.json", import.meta.url);

export const MENU_LIMITS = { maxItems: 50, nameMax: 60, maxOtherNames: 10, maxPriceSen: 1_000_000 };
export const MENU_LOCKED = "Invoices are sent for this batch. Start a New batch to change your menu.";
const FIELDS = ["name", "price", "otherNames"];
const SEND = 'Send { "name": "Pizza", "price": "25.00", "otherNames": "pz, pizzas" }.';

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

// Hidden characters (same list as a buyer's note, src/order-page.js): control characters, direction marks and
// zero-width ones. Any run of spaces, tabs or line breaks becomes one space.
const HIDDEN = /[\p{Cc}؜​-‏‪-‮⁠⁦-⁩﻿]/gu;
const tidy = (text) => text.replace(/\s+/gu, " ").replace(HIDDEN, "").replace(/ {2,}/g, " ").trim();
const length = (text) => [...text].length; // characters as people count them: an emoji is one
const hasWord = (text) => /[\p{L}\p{N}]/u.test(text);
// Same cleaning as src/orders.js: lowercase a-z and digits only, so "Choc-Chip!" and "choc chip" read the same.
const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");
const key = (name) => tidy(name).toLowerCase();

// "25", "25.5", "25.50" -> { price: "25.50", sen: 2550 }, or { error }. More than 0, at most 10,000.00.
export function readMenuPrice(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : null;
  if (text === null || text === "") return { error: "Add a price, like 25.00." };
  if (/^\d+\.\d{3,}$/.test(text)) return { error: "A price has at most 2 decimals, like 25.50." };
  const match = text.match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!match) return { error: `${JSON.stringify(text)} is not a price: use digits like 25.00.` };
  const sen = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (sen <= 0) return { error: "A price must be more than 0." };
  if (sen > MENU_LIMITS.maxPriceSen) return { error: "A price can be at most 10,000.00." };
  return { price: fromSen(sen), sen };
}

// One word's other form: "pizza" -> "pizzas", "pizzas" -> "pizza", "berry" -> "berries", "box" -> "boxes".
// Only a plain word of 3+ letters; "lapis" and "glass" count as one (-is, -us, -ss).
function otherForm(word) {
  if (!/^[a-z]{3,}$/.test(word)) return null;
  if (/(ss|us|is)$/.test(word)) return `${word}es`;
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

// The item's aliases: its short name and each other name, cleaned like chat text, each with the other form of its
// last word. A name with no a-z letters (another script) is kept as typed, so the AI still sees it.
export function matchWords(name, otherNames = []) {
  const words = [];
  for (const term of [shortName(name), ...otherNames]) {
    const clean = cleanWords(term);
    if (!clean) {
      words.push(key(term));
      continue;
    }
    words.push(clean);
    const parts = clean.split(" ");
    const other = otherForm(parts.at(-1));
    if (other) words.push([...parts.slice(0, -1), other].join(" "));
  }
  return [...new Set(words.filter(Boolean))];
}

// "pz, Pepperoni" or ["pz", "Pepperoni"] -> { names } (tidied, empty and repeated ones dropped) or { error }.
function readOtherNames(value) {
  if (value === undefined || value === null) return { names: [] };
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) return { error: "Other names must be text, split by commas." };
  const seen = new Set();
  const names = [];
  for (const raw of list) {
    const name = tidy(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  if (names.length > MENU_LIMITS.maxOtherNames) return { error: `An item can have at most ${MENU_LIMITS.maxOtherNames} other names.` };
  const long = names.find((name) => length(name) > MENU_LIMITS.nameMax);
  if (long) return { error: `Other names can be at most ${MENU_LIMITS.nameMax} characters ("${[...long].slice(0, 20).join("")}..." is longer).` };
  const empty = names.find((name) => !hasWord(name));
  if (empty) return { error: `The other name ${JSON.stringify(empty)} needs a letter or number.` };
  return { names };
}

// The words of a menu's items -> item id, for "already means X" (an item's own words don't count).
const itemWords = (item) => new Set(item.aliases.map((alias) => cleanWords(alias) || key(alias)));

// A request body -> { name, price, otherNames, aliases } or { error }. others: the menu's OTHER items.
function readItem(body, others) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: SEND };
  const extra = Object.keys(body).find((field) => !FIELDS.includes(field));
  if (extra) return { error: `"${extra}" can't be set: send only name, price and otherNames. The currency is the menu's setting.` };
  const problems = [];
  const name = typeof body.name === "string" ? tidy(body.name) : "";
  if (typeof body.name !== "string" || !name) problems.push("Add a name.");
  else if (length(name) > MENU_LIMITS.nameMax) problems.push(`A name can be at most ${MENU_LIMITS.nameMax} characters.`);
  else if (!hasWord(name)) problems.push("A name needs a letter or number.");
  else if (others.some((item) => key(item.name) === name.toLowerCase())) problems.push(`${name} is already on your menu.`);
  const price = readMenuPrice(body.price);
  if (price.error) problems.push(price.error);
  const other = readOtherNames(body.otherNames);
  if (other.error) problems.push(other.error);
  if (problems.length) return { error: problems.join(" ") };

  const aliases = matchWords(name, other.names);
  for (const item of others) {
    const taken = aliases.find((word) => itemWords(item).has(word));
    if (taken) return { error: `"${taken}" already means ${item.name} on your menu: use a different name or other name.` };
  }
  return { name, price: price.price, otherNames: other.names, aliases };
}

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
    if (length(item.name) > MENU_LIMITS.nameMax || tidy(item.name) !== item.name) problems.push(`${JSON.stringify(item.id)} has a bad name.`);
    if (item.aliases.some((alias) => typeof alias !== "string")) problems.push(`${JSON.stringify(item.id)} has a bad alias.`);
  }
  return problems;
}
