// Tests for the buyer panel (Step 7, PLAN.md Section 10 #1 "Show your work") and the QR helpers.
// Pure: the demo chats + Gemini's saved demo reply, no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buyerPanel, highlight } from "../src/panel.js";
import { pngFromQrReply } from "../src/paypal.js";
import { QR_PNG } from "../scripts/fake-paypal.mjs";
import { mockParse } from "../src/ai.js";
import { toRows } from "../src/orders.js";

const menu = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const text = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const source = { text, chatDate: "2026-10-28", messages: 18 };
const rows = toRows(mockParse(), menu);
const rowsOf = (buyer) => rows.filter((row) => row.buyer === buyer);
const marked = (msg) => msg.parts.filter((p) => p.mark).map((p) => `${p.mark}:${p.text}`);

test("Arif's panel: the AI's note and his 2 messages, both used; the question is shown too", () => {
  const panel = buyerPanel(rowsOf("Arif"), source, menu);
  assert.equal(panel.buyer, "Arif");
  assert.equal(panel.note, rowsOf("Arif")[0].note);
  assert.deepEqual(panel.messages.map((m) => [m.n, m.used]), [[6, true], [7, true]]);
  assert.equal(panel.messages[0].when, "Wed 28 Oct, 10:30");
  assert.equal(panel.messages[1].parts.map((p) => p.text).join(""), "ok if yes i'll take 2 packs, will pick up tomorrow afternoon");
  assert.deepEqual(marked(panel.messages[1]), ["qty:2 packs", "fulfilment:pick up", "day:tomorrow"]);
});

test("the buyer's name is not repeated in each message, and other buyers' messages are left out", () => {
  const panel = buyerPanel(rowsOf("Lina"), source, menu);
  assert.deepEqual(panel.messages.map((m) => m.n), [1, 4, 18]);
  assert.ok(panel.messages.every((m) => !m.parts[0].text.startsWith("Lina:")));
});

test("a message from the buyer that the AI did not use is kept but marked as not used", () => {
  const onlyFirst = rowsOf("Lina").map((row) => ({ ...row, sourceMsgs: [1, 4] }));
  const panel = buyerPanel(onlyFirst, source, menu);
  assert.deepEqual(panel.messages.map((m) => [m.n, m.used]), [[1, true], [4, true], [18, false]]);
  assert.deepEqual(marked(panel.messages[2]), []); // nothing marked in a message that wasn't used
});

test("changes, cancellations and 'same as' are marked; so are menu words", () => {
  const hafiz = buyerPanel(rowsOf("Hafiz"), source, menu);
  assert.deepEqual(marked(hafiz.messages.find((m) => m.n === 15)), ["change:skip", "item:cookies", "item:cheesecake"]);
  const aisyah = buyerPanel(rowsOf("Aisyah"), source, menu);
  assert.deepEqual(marked(aisyah.messages[0]), ["change:same as Lina", "fulfilment:pick up", "day:saturday"]);
  const danish = buyerPanel(rowsOf("Danish"), source, menu);
  assert.deepEqual(marked(danish.messages.find((m) => m.n === 14)), ["change:cancel"]);
});

test("the price a buyer wrote is marked; it is a 'check' mark only while the price check is open", () => {
  const jun = buyerPanel(rowsOf("Jun Wei"), source, menu);
  assert.ok(marked(jun.messages[0]).includes("price-check:RM15"));
  const kept = rowsOf("Jun Wei").map((row) => (row.priceCheck ? { ...row, priceCheck: { ...row.priceCheck, kept: true } } : row));
  assert.ok(marked(buyerPanel(kept, source, menu).messages[0]).includes("price:RM15"));
  const mei = buyerPanel(rowsOf("Mei Ling"), source, menu);
  assert.ok(marked(mei.messages[0]).includes("price:RM72")); // a correct price: a plain mark
});

test("highlight: plain text in, segments out that join back to the same text; whole words only", () => {
  const parts = highlight("2x cheese brownie + 1 classic, Saturday. cookiesss", { menu });
  assert.equal(parts.map((p) => p.text).join(""), "2x cheese brownie + 1 classic, Saturday. cookiesss");
  assert.deepEqual(parts.filter((p) => p.mark).map((p) => `${p.mark}:${p.text}`), ["qty:2x", "item:cheese brownie", "qty:1", "item:classic", "day:Saturday"]);
  assert.deepEqual(highlight("", { menu }), []);
  assert.deepEqual(highlight("<b>hi</b>", { menu }), [{ text: "<b>hi</b>", mark: null }]); // text, never HTML
});

test("no chats saved (e.g. an old store) -> the note only, no messages, no crash", () => {
  assert.deepEqual(buyerPanel(rowsOf("Arif"), null, menu).messages, []);
  assert.deepEqual(buyerPanel([], source, menu), { buyer: "", note: "", messages: [] });
});


test("pngFromQrReply: reads the Base64 PNG out of PayPal's multipart reply; anything else -> null", () => {
  const multipart = Buffer.from(`--b\r\nContent-Disposition: form-data; name="image"\r\n\r\n${QR_PNG}\r\n--b--\r\n`);
  const png = pngFromQrReply(multipart);
  assert.ok(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.equal(pngFromQrReply(png), png); // already a PNG
  assert.equal(pngFromQrReply(Buffer.from('{"name":"ERROR"}')), null);
  assert.equal(pngFromQrReply(Buffer.from("no picture here")), null);
});
