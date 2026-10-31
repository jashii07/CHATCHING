// The browser check for per-visitor tables: two separate browsers (Playwright contexts: each has its own
// cookies, like two judges on two laptops) use the local app AT THE SAME TIME.
//   - A new visitor: an empty table, the chat box open, Load demo visible, an HttpOnly cookie.
//   - One reads and sends, the other's table doesn't change; both send at once: 14 invoices, no number twice.
//   - Reset demo and New batch reach only the one who clicked them. A second tab in one browser shares its table.
//   - A tab left open while the server sleeps (its disk wiped) doesn't fail on Send: it shows the empty table,
//     the chat box and Load demo, with plain words.
// PayPal is the FAKE in scripts/fake-paypal.mjs (fake keys). It fails on any console error or warning.
// Run: npm run ui-visitors. Screenshots go to tmp/screenshots-visitors/ (git-ignored).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { VISITOR_COOKIE, isVisitorId } from "../src/visitors.js";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-visitors/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const LOST = "Your table was cleared";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"
const cards = async (page) => plain(await page.$eval(".summary", (el) => el.innerText));
const message = async (page, id) => plain(await page.$eval(id, (el) => el.textContent));

const fake = fakePayPal();
const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
let visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-visitors-"));

async function listen(port = 0) {
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir, paypal }).listen(port);
  await new Promise((resolve) => server.once("listening", resolve));
  return server;
}

let server = await listen();
const { port } = server.address();
const base = `http://localhost:${port}`;

// One judge: a separate browser context, so a separate cookie jar.
async function judge(name, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(base);
  await page.waitForSelector(".ag-overlay");
  await page.waitForTimeout(300);
  return { name, context, page, errors, shot: (step) => page.screenshot({ path: `${OUT}${name}-${step}.png`, fullPage: true }) };
}

async function readDemo({ page }) {
  await page.click("#load-demo");
  await page.waitForFunction(() => document.getElementById("read-message").textContent.includes("Demo chats loaded"));
  await page.click("#read-orders");
  await page.waitForSelector(ROWS);
  await page.waitForTimeout(400);
}

const stateOf = async ({ page }) => page.evaluate(async () => (await fetch("/api/state")).json());
const sendButton = (page) => page.locator("[data-send-invoices]:visible").first();

async function send({ page }) {
  await sendButton(page).click();
  await page.waitForFunction(() => /\d+ of 7 sent/.test(document.getElementById("send-message").textContent));
}

async function confirmClick(page, selector) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(selector).first().click();
  await page.waitForTimeout(400);
}

try {
  console.log(`\nTwo judges at once, ${base}`);
  const ana = await judge("ana-1280", { width: 1280, height: 800 });
  const ben = await judge("ben-390", { width: 390, height: 844 });

  for (const { name, page, context, shot } of [ana, ben]) {
    check((await cards(page)).includes("Orders 0"), `${name}: a new visitor's table is empty`);
    check(await page.locator("#chat").isVisible(), `${name}: the chat box is open`);
    check(await page.locator("#load-demo").isVisible(), `${name}: Load demo is visible`);
    const cookie = (await context.cookies()).find((c) => c.name === VISITOR_COOKIE);
    check(isVisitorId(cookie?.value) && cookie.httpOnly && cookie.sameSite === "Lax" && !cookie.secure, `${name}: an HttpOnly, SameSite=Lax cookie (not Secure on plain http)`);
    check(!(await page.evaluate(() => document.cookie)).includes(VISITOR_COOKIE), `${name}: the page's scripts can't read the id`);
    await shot("1-new");
  }
  const ids = await Promise.all([ana, ben].map(async ({ context }) => (await context.cookies())[0].value));
  check(ids[0] !== ids[1], "two browsers, two ids");

  await readDemo(ana);
  check((await cards(ana.page)).includes("Expected RM 366.00"), "Ana reads the demo");
  await ben.page.reload();
  await ben.page.waitForSelector(".ag-overlay");
  await ben.page.waitForTimeout(300);
  check((await cards(ben.page)).includes("Orders 0") && (await ben.page.locator("#load-demo").isVisible()), "Ben reloads: still his own empty table");

  await readDemo(ben);
  await Promise.all([send(ana), send(ben)]);
  check((await message(ana.page, "#send-message")).startsWith("7 of 7 sent"), `Ana, at the same moment: "${await message(ana.page, "#send-message")}"`);
  check((await message(ben.page, "#send-message")).startsWith("7 of 7 sent"), `Ben, at the same moment: "${await message(ben.page, "#send-message")}"`);
  const [anaState, benState] = await Promise.all([stateOf(ana), stateOf(ben)]);
  const numbers = [...anaState.orders, ...benState.orders].map((row) => row.invoiceNumber).filter(Boolean);
  const invoices = new Set([...anaState.orders, ...benState.orders].map((row) => row.invoiceId).filter(Boolean));
  check(new Set(numbers).size === 14 && invoices.size === 14 && fake.invoices.size === 14, `14 invoices, 14 different numbers (first: ${numbers[0]}, ${numbers[0].length} characters)`);
  await ana.shot("2-sent");
  await ben.shot("2-sent");

  const anaTab = await ana.context.newPage();
  await anaTab.goto(base);
  await anaTab.waitForSelector(ROWS);
  check((await cards(anaTab)).includes("Expected RM 366.00"), "a second tab in Ana's browser shows Ana's table");
  await anaTab.close();

  await confirmClick(ana.page, "#reset-demo");
  check((await cards(ana.page)).includes("Orders 0"), "Ana clicks Reset demo: her table is empty");
  await ben.page.reload();
  await ben.page.waitForSelector(ROWS);
  await ben.page.waitForTimeout(300);
  check((await cards(ben.page)).includes("Expected RM 366.00") && (await stateOf(ben)).orders.filter((row) => row.invoiceId).length === 8, "Ben's table and invoice links are untouched");

  await readDemo(ana);
  await confirmClick(ben.page, "[data-new-batch]:visible");
  check((await cards(ben.page)).includes("Orders 0"), "Ben clicks New batch: his table is empty");
  await ana.page.reload();
  await ana.page.waitForSelector(ROWS);
  await ana.page.waitForTimeout(300);
  check((await cards(ana.page)).includes("Expected RM 366.00"), "Ana's table is untouched");

  // A tab left open while Render sleeps: the server comes back on a wiped disk, knowing nothing.
  console.log("\nA tab left open while the server sleeps");
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-visitors-woken-"));
  server = await listen(port);
  const creates = fake.count("create");
  check((await cards(ana.page)).includes("Expected RM 366.00"), "the old tab still shows its rows (the page doesn't know yet)");
  await sendButton(ana.page).click();
  await ana.page.waitForFunction((words) => document.getElementById("read-message").textContent.includes(words), LOST, { timeout: 5000 }).catch(() => {});
  await ana.page.waitForTimeout(400);
  check((await message(ana.page, "#read-message")).includes(LOST), `Send says what happened: "${await message(ana.page, "#read-message")}"`);
  check((await cards(ana.page)).includes("Orders 0"), "the table shows the truth: empty");
  check(await ana.page.locator("#load-demo").isVisible(), "the chat box and Load demo are back");
  check(fake.count("create") === creates, "no invoice was attempted");
  await ana.page.evaluate(() => scrollTo(0, 0)); // a full-page shot of a scrolled page draws the sticky bars mid-page
  await ana.shot("3-woken");
  await readDemo(ana);
  check((await cards(ana.page)).includes("Expected RM 366.00") && !(await message(ana.page, "#read-message")).includes(LOST), "Load demo + Read orders work straight away, and the words go");

  // Coming back to the tab after the same kind of restart shows the truth by itself.
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-visitors-woken2-"));
  server = await listen(port);
  await ana.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await ana.page.waitForFunction((words) => document.getElementById("read-message").textContent.includes(words), LOST, { timeout: 5000 }).catch(() => {});
  check((await cards(ana.page)).includes("Orders 0"), "coming back to the tab shows the empty table without any click");

  // The server's table is gone and the judge clicks a row FIRST: the page recovers, and logs no red 404.
  await readDemo(ana);
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-visitors-woken3-"));
  server = await listen(port);
  await ana.page.locator(ROWS).first().locator(".chips").click();
  await ana.page.waitForFunction((words) => document.getElementById("read-message").textContent.includes(words), LOST, { timeout: 5000 }).catch(() => {});
  await ana.page.waitForTimeout(400);
  check((await message(ana.page, "#read-message")).includes(LOST), `a row clicked first says what happened: "${await message(ana.page, "#read-message")}"`);
  check((await cards(ana.page)).includes("Orders 0") && !(await ana.page.locator("#drawer.is-open").count()), "the drawer closes and the table shows the truth: empty");

  for (const { name, errors } of [ana, ben]) check(errors.length === 0, `${name}: no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  for (const { name, page } of [ana, ben]) check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no sideways scroll`);
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: two visitors never touch each other's tables.");
process.exitCode = failed ? 1 : 0;
