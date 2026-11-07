// "My menu" (7 Nov): the checks for one menu item, shared by the server (src/menu.js) and the page (public/app.js),
// like next-step.js and csv-safe.js. The page runs them before it sends anything, so a typo never reaches the
// server as a refused request (a red line in the browser's console); the server runs the very same code as the
// guard. Pure: no files, no network, no clock.
// - A price is typed as text ("25" or "25.50") and read straight into whole sen (no floats): more than 0, at most
//   10,000.00, at most 2 decimals. It is kept as "25.50", the form all the money code reads.
// - Names and other names are untrusted text, like a buyer's note: hidden characters go and any run of spaces or
//   line breaks becomes one space (so a name stays on its own line in the AI's prompt). Every page shows them
//   with textContent, never as HTML.
// - "Other names" are the words buyers use in chats ("pz", "pepperoni"). The short name and each other name become
//   the item's aliases (what the AI is told, and what the no-AI reader matches), each with a simple plural.

export const MENU_LIMITS = { maxItems: 50, nameMax: 60, maxOtherNames: 10, maxPriceSen: 1_000_000 };
const FIELDS = ["name", "price", "otherNames"];
const SEND = 'Send { "name": "Pizza", "price": "25.00", "otherNames": "pz, pizzas" }.';

// Hidden characters (the same list as a buyer's note, src/order-page.js): control characters, direction marks and
// zero-width ones.
const HIDDEN = /[\p{Cc}؜​-‏‪-‮⁠⁦-⁩﻿]/gu;
export const tidy = (text) => String(text).replace(/\s+/gu, " ").replace(HIDDEN, "").replace(/ {2,}/g, " ").trim();
export const textLength = (text) => [...text].length; // characters as people count them: an emoji is one
const hasWord = (text) => /[\p{L}\p{N}]/u.test(text);
// The same cleaning as src/orders.js: lowercase a-z and digits only, so "Choc-Chip!" and "choc chip" read the same.
const cleanWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");
const nameKey = (name) => tidy(name).toLowerCase();

// "25", "25.5", "25.50" -> { price: "25.50", sen: 2550 }, or { error }.
export function readMenuPrice(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : null;
  if (text === null || text === "") return { error: "Add a price, like 25.00." };
  if (/^\d+\.\d{3,}$/.test(text)) return { error: "A price has at most 2 decimals, like 25.50." };
  const match = text.match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!match) return { error: `${JSON.stringify(text)} is not a price: use digits like 25.00.` };
  const sen = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (sen <= 0) return { error: "A price must be more than 0." };
  if (sen > MENU_LIMITS.maxPriceSen) return { error: "A price can be at most 10,000.00." };
  return { price: `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`, sen };
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

// The item's aliases: its short name and each other name, cleaned like chat text, each with the other form of
// its last word. A name with no a-z letters (another script) is kept as typed, so the AI still sees it.
export function matchWords(name, otherNames = []) {
  const words = [];
  for (const term of [shortName(name), ...otherNames]) {
    const clean = cleanWords(term);
    if (!clean) {
      words.push(nameKey(term));
      continue;
    }
    words.push(clean);
    const parts = clean.split(" ");
    const other = otherForm(parts.at(-1));
    if (other) words.push([...parts.slice(0, -1), other].join(" "));
  }
  return [...new Set(words.filter(Boolean))];
}

// "pz, Pepperoni" or ["pz", "Pepperoni"] -> { names } (tidied; empty and repeated ones dropped) or { error }.
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
  const long = names.find((name) => textLength(name) > MENU_LIMITS.nameMax);
  if (long) return { error: `Other names can be at most ${MENU_LIMITS.nameMax} characters ("${[...long].slice(0, 20).join("")}..." is longer).` };
  const empty = names.find((name) => !hasWord(name));
  if (empty) return { error: `The other name ${JSON.stringify(empty)} needs a letter or number.` };
  return { names };
}

// An item's chat words, cleaned the same way, for "already means X".
const itemWords = (item) => new Set(item.aliases.map((alias) => cleanWords(alias) || nameKey(alias)));

// A request body + the menu's OTHER items -> { name, price, otherNames, aliases } or { error }. Only name, price
// and otherNames can be sent: never an id, a currency or anything else.
export function readItem(body, others) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: SEND };
  const extra = Object.keys(body).find((field) => !FIELDS.includes(field));
  if (extra) return { error: `"${extra}" can't be set: send only name, price and otherNames. The currency is the menu's setting.` };
  const problems = [];
  const name = typeof body.name === "string" ? tidy(body.name) : "";
  if (typeof body.name !== "string" || !name) problems.push("Add a name.");
  else if (textLength(name) > MENU_LIMITS.nameMax) problems.push(`A name can be at most ${MENU_LIMITS.nameMax} characters.`);
  else if (!hasWord(name)) problems.push("A name needs a letter or number.");
  else if (others.some((item) => nameKey(item.name) === name.toLowerCase())) problems.push(`${name} is already on your menu.`);
  const price = readMenuPrice(body.price);
  if (price.error) problems.push(price.error);
  const other = readOtherNames(body.otherNames);
  if (other.error) problems.push(other.error);
  if (problems.length) return { error: problems.join(" ") };

  const aliases = matchWords(name, other.names);
  for (const item of others) {
    const words = itemWords(item);
    const taken = aliases.find((word) => words.has(word));
    if (taken) return { error: `"${taken}" already means ${item.name} on your menu: use a different name or other name.` };
  }
  return { name, price: price.price, otherNames: other.names, aliases };
}

// The other names to show in the editor: the ones the seller typed, or the demo item's aliases.
export const shownOtherNames = (item) => (Array.isArray(item.otherNames) ? item.otherNames : item.aliases);
