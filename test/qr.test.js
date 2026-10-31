// Tests for reading an invoice out of a scanned QR or a typed box (Step 10c, Part 1). Pure: no network.
// The two "real" strings were decoded from real PayPal sandbox QR codes in Step 7 (25 and 29 Oct).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_OUR_QR, invoiceIdFromQr, invoiceRefFromTyped, isInvoiceRef, isPairCode, pairLinkFrom } from "../public/invoice-qr.js";

const REAL_QR = [
  ["https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1", "INV2-BKCU-NGE3-RZG3-U35Y"],
  ["https://www.sandbox.paypal.com/invoice/payerView/details/INV2-RPHX-C6TE-8V3H-M4LL?qr=1", "INV2-RPHX-C6TE-8V3H-M4LL"],
];
const GOOD_ID = "INV2-BKCU-NGE3-RZG3-U35Y";
const PAYER_PATH = `/invoice/payerView/details/${GOOD_ID}`;

test("the words for anything that isn't ours", () => {
  assert.equal(NOT_OUR_QR, "This isn't a ChatChing invoice QR.");
});

test("the real QR contents from Step 7 give their invoice ids", () => {
  for (const [text, id] of REAL_QR) assert.equal(invoiceIdFromQr(text), id);
});

test("a payer link without ?qr=1 still counts; stray spaces around it don't matter", () => {
  assert.equal(invoiceIdFromQr(`https://www.sandbox.paypal.com${PAYER_PATH}`), GOOD_ID);
  assert.equal(invoiceIdFromQr(`  https://www.sandbox.paypal.com${PAYER_PATH}?qr=1\n`), GOOD_ID);
});

test("bad QR contents give null, so the page says NOT_OUR_QR", () => {
  const bad = {
    "nothing": "",
    "only spaces": "   ",
    "plain words": "hello",
    "a bare id is not a link": GOOD_ID,
    "another website": "https://example.com/menu",
    "a live PayPal link (this app is sandbox only)": `https://www.paypal.com${PAYER_PATH}?qr=1`,
    "not https": `http://www.sandbox.paypal.com${PAYER_PATH}?qr=1`,
    "a look-alike host": `https://www.sandbox.paypal.com.evil.example${PAYER_PATH}?qr=1`,
    "a look-alike subdomain": `https://sandbox.paypal.com${PAYER_PATH}`,
    "a host hidden behind a login part": `https://www.sandbox.paypal.com@evil.example${PAYER_PATH}`,
    "a login part in front of the real host": `https://user@www.sandbox.paypal.com${PAYER_PATH}`,
    "another port": `https://www.sandbox.paypal.com:8443${PAYER_PATH}`,
    "the real link inside another link": `https://evil.example/?next=https://www.sandbox.paypal.com${PAYER_PATH}`,
    "another PayPal page": "https://www.sandbox.paypal.com/myaccount/summary",
    "extra path after the id": `https://www.sandbox.paypal.com${PAYER_PATH}/extra`,
    "an id with too few groups": "https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3",
    "an id with too many groups": `https://www.sandbox.paypal.com${PAYER_PATH}-ABCD`,
    "a short group": "https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKC-NGE3-RZG3-U35Y",
    "a lower-case id": "https://www.sandbox.paypal.com/invoice/payerView/details/inv2-bkcu-nge3-rzg3-u35y",
    "the wrong prefix": "https://www.sandbox.paypal.com/invoice/payerView/details/INV3-BKCU-NGE3-RZG3-U35Y",
    "a very long text": `https://www.sandbox.paypal.com${PAYER_PATH}?x=${"a".repeat(3000)}`,
  };
  for (const [label, text] of Object.entries(bad)) assert.equal(invoiceIdFromQr(text), null, label);
});

test("anything that isn't text gives null, never a crash", () => {
  for (const value of [null, undefined, 42, {}, [], true]) assert.equal(invoiceIdFromQr(value), null);
});

test("typed: the invoice id, in any case, with stray spaces", () => {
  assert.equal(invoiceRefFromTyped(GOOD_ID), GOOD_ID);
  assert.equal(invoiceRefFromTyped("  inv2-bkcu-nge3-rzg3-u35y "), GOOD_ID);
});

test("typed: the invoice number", () => {
  assert.equal(invoiceRefFromTyped("CHATCHING-K3F9Q2ZA7L1X-07"), "CHATCHING-K3F9Q2ZA7L1X-07");
  assert.equal(invoiceRefFromTyped("chatching-k3f9q2za7l1x-07"), "CHATCHING-K3F9Q2ZA7L1X-07");
});

test("pasted: the QR link, and the payer link the table shows and Copy link copies", () => {
  assert.equal(invoiceRefFromTyped(REAL_QR[0][0]), GOOD_ID);
  assert.equal(invoiceRefFromTyped(`https://www.sandbox.paypal.com/invoice/p/#${GOOD_ID}`), GOOD_ID);
});

test("typed: anything else gives null", () => {
  for (const text of ["", "   ", "hello", "07", "CHATCHING-K3F9Q2ZA7L1X", "CHATCHING-SHORT-07", "INV2-BKCU", "https://example.com/invoice/p/#INV2-BKCU-NGE3-RZG3-U35Y", "https://www.paypal.com/invoice/p/#INV2-BKCU-NGE3-RZG3-U35Y", null, 7]) {
    assert.equal(invoiceRefFromTyped(text), null, String(text));
  }
});

test("the QR rule stays strict: a typed-only form never counts as a scanned QR", () => {
  assert.equal(invoiceIdFromQr(`https://www.sandbox.paypal.com/invoice/p/#${GOOD_ID}`), null);
  assert.equal(invoiceIdFromQr("CHATCHING-K3F9Q2ZA7L1X-07"), null);
});

test("isInvoiceRef: the server's own check of what the page sent", () => {
  assert.equal(isInvoiceRef(GOOD_ID), true);
  assert.equal(isInvoiceRef("CHATCHING-K3F9Q2ZA7L1X-07"), true);
  for (const value of ["inv2-bkcu-nge3-rzg3-u35y", "hello", "", null, 7, ["INV2-BKCU-NGE3-RZG3-U35Y"]]) assert.equal(isInvoiceRef(value), false, String(value));
});

// ---- "Open on my phone": the in-app Pickup scan knows our own pairing QR too ----

const SITE = "https://chatching.onrender.com";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";

test("our own pairing link gives the link back, so the scan can open it", () => {
  assert.equal(pairLinkFrom(`${SITE}/pair#${CODE}`, SITE), `${SITE}/pair#${CODE}`);
  assert.equal(pairLinkFrom(`  ${SITE}/pair#${CODE}\n`, SITE), `${SITE}/pair#${CODE}`);
  assert.equal(isPairCode(CODE), true);
});

test("a pairing link is ours only on this very site, in this exact shape", () => {
  const bad = {
    "another site": `https://evil.example/pair#${CODE}`,
    "a look-alike": `https://chatching.onrender.com.evil.example/pair#${CODE}`,
    "a login part": `https://chatching.onrender.com@evil.example/pair#${CODE}`,
    "a login part on our own site": `https://me@chatching.onrender.com/pair#${CODE}`,
    "a login and password on our own site": `https://me:secret@chatching.onrender.com/pair#${CODE}`,
    "http": `http://chatching.onrender.com/pair#${CODE}`,
    "another page": `${SITE}/pairing#${CODE}`,
    "a query": `${SITE}/pair?x=1#${CODE}`,
    "no code": `${SITE}/pair`,
    "a short code": `${SITE}/pair#abc`,
    "a long code": `${SITE}/pair#${CODE}x`,
    "a bad letter": `${SITE}/pair#${CODE.slice(1)}!`,
    "not a link": "hello",
    "nothing": "",
  };
  for (const [name, text] of Object.entries(bad)) assert.equal(pairLinkFrom(text, SITE), null, name);
  assert.equal(pairLinkFrom(null, SITE), null);
  assert.equal(pairLinkFrom(`${SITE}/pair#${CODE}${" ".repeat(3000)}`, SITE), null, "too long");
});

test("a pairing link is not an invoice: the two readers never mix them up", () => {
  assert.equal(invoiceIdFromQr(`${SITE}/pair#${CODE}`), null);
  assert.equal(invoiceRefFromTyped(`${SITE}/pair#${CODE}`), null);
  assert.equal(pairLinkFrom("https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1", SITE), null);
});
