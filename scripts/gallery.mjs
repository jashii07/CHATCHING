// Makes the 6 Devpost gallery images (1500 x 1000 px, 3:2), shot list in docs/devpost-draft.md.
// LOCAL server + the FAKE PayPal (scripts/fake-paypal.mjs, fake keys): no network, no real invoices, no AI calls.
// Run: npm run gallery (uses the installed Google Chrome). Images go to tmp/gallery/ (git-ignored).
// Planned for Mon 9 Nov, after the design polish (PLAN.md Section 9).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/gallery/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const SIZE = { width: 1500, height: 1000 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const visitorsDir = mkdtempSync(join(tmpdir(), "chatching-gallery-"));
const fake = fakePayPal();
const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
let skew = 0; // moves the server past its 10-second status cache without waiting
const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir, paypal, now: () => Date.now() + skew }).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}${name}.png` }); console.log(`saved tmp/gallery/${name}.png`); };
// Puts an element just under the sticky top bar (64 px + a 16 px gap), so each shot frames its subject whole.
const frameAt = (selector) => page.evaluate((sel) => {
  const top = document.querySelector(sel).getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - 80));
}, selector);
const stateNow = async () => (await page.request.get(`${base}/api/state`)).json();
const order = async (buyer) => (await stateNow()).orders.find((row) => row.buyer === buyer);

try {
  // 1. The table after Read orders.
  await page.goto(base);
  await page.click("#load-demo");
  await page.waitForFunction(() => document.getElementById("read-message").textContent.includes("Demo chats loaded"));
  await page.click("#read-orders");
  await page.waitForSelector(ROWS);
  await frameAt(".summary"); // Read orders scrolls the table into view, which cut the hero card in half
  await shot("1-table-after-read");

  // 2. An amber Check row with Copy question (filtered to the rows to check), both check rows in full.
  await page.click("#stat-check");
  await page.waitForTimeout(300);
  await page.locator(ROWS, { hasText: "Priya" }).locator('.copy-text[data-kind="question"]').click();
  await page.click(".panel.orders .panel-head h2"); // moves focus out of the table: no focus box on Priya's cell
  await frameAt("#chat-bar"); // both check rows whole, and the footer stays out of view
  await shot("2-check-row-copy-question");
  await page.click("#stat-check");

  // 3. Send invoices with the progress bar, caught mid-way.
  fake.slow("send", 800);
  await page.locator("[data-send-invoices]:visible").first().click();
  await page.waitForFunction(() => document.getElementById("send-message").textContent.startsWith("Sending invoice 3 of"), null, { timeout: 20000 });
  await frameAt(".summary"); // the cards, the bar and the first Sent rows (each send is held 800 ms, so the bar stays at 3)
  await shot("3-send-invoices-progress");
  fake.slow("send", 0);
  await page.waitForFunction(() => /\d+ of \d+ sent/.test(document.getElementById("send-message").textContent), null, { timeout: 30000 });

  // 4. A Paid row in green, with the Paid card.
  fake.pay((await order("Hafiz")).invoiceId);
  skew += 11_000;
  await page.click("#refresh-status");
  await page.waitForFunction(() => document.getElementById("stat-paid").classList.contains("is-paid"), null, { timeout: 10000 });
  // The search box (AG Grid's quick filter) shows only Hafiz, so his green row fits under the green Paid card.
  // Got it closes the "Invoices sent" banner (since 1.11.0 it pushed his row below the bottom edge).
  await page.click("#sent-banner-close");
  await page.fill("#search", "Hafiz");
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, ROWS);
  await frameAt(".summary");
  await shot("4-paid-row");
  await page.fill("#search", "");

  // 5. The Kitchen list.
  await page.click("#kitchen-list");
  await page.waitForSelector(".kitchen-day");
  await shot("5-kitchen-list");
  await page.keyboard.press("Escape");

  // 6. The Pickup scan result on a phone (same table: same browser context), typed, then put in a phone frame.
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(base);
  await phone.waitForSelector(ROWS);
  await phone.locator("[data-pickup-scan]:visible").first().click();
  await phone.waitForSelector("#scan-input", { state: "visible", timeout: 10000 });
  await phone.fill("#scan-input", (await order("Hafiz")).invoiceNumber);
  await phone.click("#scan-check");
  await phone.waitForSelector("#scan-result:not([hidden])");
  await phone.waitForTimeout(400);
  const png = (await phone.screenshot()).toString("base64");
  await phone.close();
  const frame = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  await frame.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#F7F3EA">
    <div style="padding:14px;border-radius:52px;background:#1B2340;box-shadow:0 24px 60px rgba(27,35,64,.25)">
      <img src="data:image/png;base64,${png}" style="display:block;width:390px;height:844px;border-radius:40px"></div></body>`);
  await frame.screenshot({ path: `${OUT}6-pickup-scan-phone.png` });
  console.log("saved tmp/gallery/6-pickup-scan-phone.png");
} finally {
  await browser.close();
  server.close();
  rmSync(visitorsDir, { recursive: true, force: true });
}
