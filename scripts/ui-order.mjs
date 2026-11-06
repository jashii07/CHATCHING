// The browser check for the buyer's "Your order" page (6 Nov), phone first (390 px), then laptop (1280 px).
// The buyer is a browser of its own with NO cookie, opening the link from the seller's Copy message:
//   Lina: her items, total, day, delivery, Not paid, her own messages marked, the Pay button to PayPal's page;
//         Looks right -> the seller's table and drawer say "Confirmed by buyer"; she pays (fake PayPal) and,
//         back on the tab, sees Paid and the pickup QR; after Collected, no QR.
//   Hafiz: Something's wrong with a note full of HTML -> it shows as plain characters on both sides, nothing
//          runs, and the seller's row turns amber with the note. Money never changes.
//   A wrong link: the friendly words only. No visitor cookie, no other site, no sideways scroll, no console line.
// PayPal is the FAKE in scripts/fake-paypal.mjs. Run: npm run ui-order. Screenshots: tmp/screenshots-order/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { ORDER_LINK_GONE } from "../src/order-links.js";
import { VISITOR_COOKIE } from "../src/visitors.js";
import { fakePayPal } from "./fake-paypal.mjs";
import { testVisitor, visitorPage } from "./test-visitor.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-order/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "laptop", width: 1280, height: 800 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const XSS = `<img src=x onerror="window.__xss=1"><b>2</b> cheesecakes pls`;
const BLUE = "rgb(58, 91, 199)";
const GREEN = "rgb(220, 242, 227)";
const AMBER = "rgb(252, 239, 214)";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => String(text).replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"
const words = async (page, selector) => plain(await page.$eval(selector, (el) => el.innerText));
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

function watch(page, errors, base) {
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("request", (req) => !req.url().startsWith(base) && !req.url().startsWith("data:") && errors.push(`other site: ${req.url()}`));
}

async function goToBuyerPage(page, buyer) {
  for (let i = 0; i < 3 && !(await page.locator(ROWS, { hasText: buyer }).count()); i++) {
    const next = !(await page.$eval("#page-next", (el) => el.disabled));
    await page.click(next ? "#page-next" : "#page-prev");
    await page.waitForTimeout(200);
  }
}

// The buyer: a browser of its own, no cookie; on a phone, a phone's screen.
async function buyerPage(viewport, base, errors) {
  const context = await browser.newContext({ viewport, ...(viewport.name === "phone" && { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }) });
  const page = await context.newPage();
  watch(page, errors, base);
  return page;
}

try {
  for (const viewport of WIDTHS) {
    console.log(`\n${viewport.width} px (${viewport.name})`);
    const visitor = testVisitor();
    const fake = fakePayPal();
    let skew = 0;
    const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
    const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir: visitor.dir, paypal, now: () => Date.now() + skew }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://localhost:${server.address().port}`;
    const shot = (page, name, fullPage = true) => page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-${name}.png`, fullPage });

    // The seller sends the invoices and copies Lina's message.
    const sellerErrors = [];
    const seller = await visitorPage(browser, visitor, base, { viewport, permissions: ["clipboard-read", "clipboard-write"] });
    // The seller's page loads AG Grid and Lucide from their pinned CDN files, so only its console is watched.
    seller.on("console", (msg) => ["error", "warning"].includes(msg.type()) && sellerErrors.push(`${msg.type()}: ${msg.text()}`));
    seller.on("pageerror", (err) => sellerErrors.push(err.message));
    await seller.goto(base);
    await seller.waitForSelector(ROWS);
    await seller.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    await seller.reload();
    await seller.waitForSelector(ROWS);
    const state = await seller.evaluate(() => fetch("/api/state").then((r) => r.json()));
    const linkOf = (buyer) => state.texts.find((t) => t.buyer === buyer).message.split(" ").at(-1);
    const rowOf = (buyer) => state.orders.find((row) => row.buyer === buyer);
    await goToBuyerPage(seller, "Lina");
    await seller.locator(ROWS, { hasText: "Lina" }).locator('.copy-text[data-kind="message"]').click();
    await seller.waitForTimeout(200);
    const copied = (await seller.evaluate(() => navigator.clipboard.readText())).trim();
    check(copied.endsWith(linkOf("Lina")) && copied.includes(`${base}/order#`) && !copied.includes(rowOf("Lina").payerLink),
      `Copy message holds Lina's order page, not PayPal's link: "${copied.slice(-90)}"`);

    // ---- Lina opens her link ----
    const errors = [];
    const lina = await buyerPage(viewport, base, errors);
    await lina.goto(linkOf("Lina"));
    await lina.waitForSelector("#order-content:not([hidden])");
    check((await words(lina, "h1")) === "Your order" && (await words(lina, "#order-words")) === "Hi Lina! Please check what the seller got from your messages.", "her greeting");
    check((await words(lina, "#order-items")) === "3 × Classic brownies (box of 6) RM 54.00" && (await words(lina, "#order-total")) === "RM 54.00",
      `items and total from the menu: "${await words(lina, "#order-items")}"`);
    check((await words(lina, "#order-when")) === "Delivery, Sat 31 Oct", `day and delivery: "${await words(lina, "#order-when")}"`);
    check((await words(lina, "#order-status")) === "Not paid", `status: "${await words(lina, "#order-status")}"`);
    const pay = await lina.$eval("#pay-link", (el) => ({ href: el.href, text: el.innerText.replace(/\s+/g, " "), target: el.target, rel: el.rel, bg: getComputedStyle(el).backgroundColor, h: el.getBoundingClientRect().height }));
    check(pay.href === rowOf("Lina").payerLink && pay.text === "Pay RM 54.00 with PayPal" && pay.target === "_blank" && pay.rel.includes("noreferrer") && pay.bg === BLUE && pay.h >= 44,
      `the Pay button opens her PayPal invoice (${JSON.stringify(pay)})`);
    const messages = await lina.$$eval("#order-messages .chat-msg", (els) => els.map((el) => ({ text: el.querySelector(".chat-text").textContent, marks: el.querySelectorAll("mark").length })));
    // Her 3rd message ("pls send me the payment link later") names no item, number or day: no marks, as in the drawer.
    check(messages.length === 3 && messages[0].marks > 0 && messages[1].marks > 0 && messages[1].text === "oh wait, make it 3 boxes, my friend wants some too",
      `her 3 messages, marked as in the drawer (${JSON.stringify(messages.map((m) => m.marks))})`);
    const body = await lina.content();
    check(!body.includes(visitor.id) && !["Hafiz", "Mei Ling", "Aisyah", "Priya"].some((name) => body.includes(name)), "no visitor id and no other buyer on her page");
    check((await lina.context().cookies()).every((c) => c.name !== VISITOR_COOKIE), "opening the page gave her no visitor cookie");
    check(await noSideScroll(lina), "no sideways scroll");
    const taps = await lina.$$eval("button:not([hidden]), a.button-link", (els) => els.filter((el) => el.offsetParent).map((el) => Math.round(el.getBoundingClientRect().height)));
    check(taps.every((h) => h >= 44), `every button is at least 44 px tall (${taps.join(", ")})`);
    await shot(lina, "1-lina");

    // Looks right.
    await lina.click("#answer-ok");
    await lina.waitForSelector("#answer-said:not([hidden])");
    check((await words(lina, "#answer-said")) === "You said this looks right. Thank you!", `after Looks right: "${await words(lina, "#answer-said")}"`);
    await seller.reload();
    await seller.waitForSelector(ROWS);
    await goToBuyerPage(seller, "Lina");
    const linaRow = plain(await seller.locator(ROWS, { hasText: "Lina" }).innerText());
    check(linaRow.includes("Confirmed by buyer"), `the seller's row: "${linaRow.slice(0, 120)}"`);
    await seller.locator(ROWS, { hasText: "Lina" }).locator(".chips").click();
    await seller.waitForSelector("#drawer.is-open #answer-card");
    check((await words(seller, "#answer-card")).startsWith("Confirmed by buyer"), `the seller's drawer: "${await words(seller, "#answer-card")}"`);
    await seller.$eval("#answer-card", (el) => el.scrollIntoView({ block: "start" }));
    await seller.waitForTimeout(500); // the drawer's slide-in
    await shot(seller, "2-seller-confirmed", false);
    await seller.keyboard.press("Escape");

    // ---- Hafiz: Something's wrong, with HTML in the note ----
    const hafiz = await buyerPage(viewport, base, errors);
    await hafiz.goto(linkOf("Hafiz"));
    await hafiz.waitForSelector("#order-content:not([hidden])");
    await hafiz.click("#answer-wrong");
    await hafiz.fill("#answer-note", XSS);
    check((await words(hafiz, "#answer-count")) === String(XSS.length), "the counter counts the note");
    check((await hafiz.$eval("#answer-note", (el) => el.maxLength)) === 200, "the note box stops at 200 characters");
    await shot(hafiz, "3-hafiz-note");
    await hafiz.click("#answer-send");
    await hafiz.waitForSelector("#answer-said.is-wrong");
    check((await hafiz.$eval("#answer-said", (el) => el.textContent)) === `You told the seller something's wrong: "${XSS}"`, "his note shows as plain characters");
    check(!(await hafiz.$("#answer-said img, #answer-said b")) && !(await hafiz.evaluate(() => window.__xss)), "nothing in the note became HTML or ran");
    check((await hafiz.$eval("#answer-said", (el) => getComputedStyle(el).backgroundColor)) === AMBER, "amber: check this");
    await seller.reload();
    await seller.waitForSelector(ROWS);
    await goToBuyerPage(seller, "Hafiz");
    const hafizRow = seller.locator(ROWS, { hasText: "Hafiz" });
    const hafizText = plain(await hafizRow.innerText());
    check(hafizText.includes(`Buyer says something's wrong: ${plain(XSS)}`) && (await hafizRow.getAttribute("class")).includes("row-unclear"),
      `the seller's row is amber with his note: "${hafizText.slice(0, 160)}"`);
    check(hafizText.includes("RM 45.00"), "his total did not change");
    await hafizRow.locator(".chips").click();
    await seller.waitForSelector("#drawer.is-open #answer-card");
    check((await seller.$eval("#answer-card .check-text", (el) => el.textContent)) === `Buyer says something's wrong: ${XSS}` && !(await seller.$("#answer-card img, #answer-card b")),
      "the drawer shows the note as text");
    check(!(await seller.evaluate(() => window.__xss)), "nothing ran on the seller's page");
    await seller.$eval("#answer-card", (el) => el.scrollIntoView({ block: "start" }));
    await seller.waitForTimeout(500); // the drawer's slide-in
    await shot(seller, "4-seller-flagged", false);
    await seller.keyboard.press("Escape");

    // ---- Lina pays; back on her tab she sees Paid and her QR ----
    fake.pay(rowOf("Lina").invoiceId);
    skew += 10_000; // past the server's 10-second status cache
    await lina.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // she comes back from PayPal's tab
    await lina.waitForFunction(() => document.getElementById("order-status").textContent === "Paid");
    check(await lina.$eval("#order-pay", (el) => el.hidden), "Pay is gone once paid");
    check((await words(lina, "#paid-title")) === "Paid. Thank you!" && (await lina.$eval("#order-paid", (el) => getComputedStyle(el).backgroundColor)) === GREEN, "the green Paid card");
    const qr = await lina.$eval("#order-qr-image", (el) => ({ ok: el.complete && el.naturalWidth > 0, alt: el.alt })).catch(() => ({}));
    check(qr.ok, `her QR shows once paid (${JSON.stringify(qr)})`);
    check((await words(lina, "#order-qr")).endsWith("Show this QR when you get your order."), `the QR words: "${await words(lina, "#order-qr")}"`);
    await shot(lina, "5-lina-paid");
    await seller.evaluate((id) => fetch("/api/pickup/collected", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoiceId: id }) }), rowOf("Lina").invoiceId);
    await lina.reload();
    await lina.waitForFunction(() => document.getElementById("order-status").textContent === "Collected");
    check(!(await lina.$("#order-qr-image")) && (await words(lina, "#paid-title")) === "Collected. Thank you!", "after Collected: no QR");

    // ---- A wrong link ----
    const stranger = await buyerPage(viewport, base, errors);
    await stranger.goto(`${base}/order#${"x".repeat(43)}`);
    await stranger.waitForFunction((gone) => document.getElementById("order-words").textContent === gone, ORDER_LINK_GONE);
    check(await stranger.$eval("#order-content", (el) => el.hidden), "a wrong link: only the friendly words");
    await shot(stranger, "6-wrong-link", false);

    check(!errors.length, `no console errors or other sites on the buyer pages${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(!sellerErrors.length, `no console errors on the seller's page${sellerErrors.length ? `: ${sellerErrors.join(" | ")}` : ""}`);
    for (const page of [lina, hafiz, stranger]) await page.context().close();
    await seller.context().close();
    server.closeAllConnections();
    server.close();
  }
} finally {
  await browser.close();
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed. Screenshots in tmp/screenshots-order/` : "\nPASS: the buyer's order page works at 390 and 1280 px. Screenshots in tmp/screenshots-order/");
process.exitCode = failed ? 1 : 0;
