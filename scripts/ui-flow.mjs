// The browser check for the whole flow so far, at laptop and phone widths, from an EMPTY table:
//   Step 4: random text -> the friendly mock notice; the demo chats -> loading message, button disabled,
//           table fills, chats fold into the slim bar, summary cards update, Priya amber.
//   Step 5: Send invoices -> one invoice per clear buyer, payer links + Copy appear; clicking again
//           creates nothing new; Read orders is refused; New batch empties the table and reading works again.
// PayPal is the FAKE in scripts/fake-paypal.mjs (fake keys): no network, no real invoices.
// It fails on any console error or warning.
// Run: npm run ui-flow (uses the installed Google Chrome, no download).
// Each width gets its own server and store file in tmp/, so your saved orders in data/runtime/ are never
// touched. Screenshots go to tmp/screenshots-flow/ (git-ignored).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-flow/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const MOCK_NOTICE = "Mock mode only knows the demo chats - the real AI comes in Step 7.";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"

// A fresh server whose store starts EMPTY (no rows, no chats), as for a seller on their first day.
async function startServer(name) {
  const storeFile = `${OUT}${name}-orders.json`;
  writeFileSync(storeFile, JSON.stringify({ rows: [], source: null }));
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, storeFile, paypal }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, fake };
}

const bodyRows = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
const cards = async (page) => plain(await page.$eval(".summary", (el) => el.innerText));
const readMessage = async (page) => plain(await page.$eval("#read-message", (el) => el.textContent));

// Every buyer's row text, across all pages (6 buyers per page).
async function allBuyers(page) {
  const seen = [...(await bodyRows(page))];
  while (!(await page.$eval("#pager", (el) => el.hidden)) && !(await page.$eval("#page-next", (el) => el.disabled))) {
    await page.click("#page-next");
    await page.waitForTimeout(300);
    seen.push(...(await bodyRows(page)));
  }
  while (!(await page.$eval("#pager", (el) => el.hidden)) && !(await page.$eval("#page-prev", (el) => el.disabled))) {
    await page.click("#page-prev");
    await page.waitForTimeout(200);
  }
  return seen;
}

try {
  for (const viewport of WIDTHS) {
    const { server, fake } = await startServer(viewport.name);
    const base = `http://localhost:${server.address().port}`;
    const page = await browser.newPage({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
    const errors = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    let posts = 0;
    page.on("request", (req) => req.url().endsWith("/api/parse") && req.method() === "POST" && posts++);

    console.log(`\n${viewport.width} px (${viewport.name})`);
    await page.goto(base);
    await page.waitForSelector(".ag-overlay");
    await page.waitForTimeout(400);
    const empty = plain(await page.$eval(".ag-overlay", (el) => el.innerText));
    check(empty.includes("No orders yet"), `starts empty: "${empty}"`);
    check((await cards(page)).includes("Orders 0") && !(await page.$eval("#chats", (el) => el.hidden)), "Orders 0, and the chat box is open");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-1-empty.png`, fullPage: true });

    // Random text -> the friendly mock notice; nothing else changes.
    await page.fill("#chat", "hello! are you open tomorrow? i want to order something nice");
    await page.fill("#chat-date", "2026-10-28");
    await page.click("#read-orders");
    await page.waitForFunction((text) => document.getElementById("read-message").textContent.includes(text), MOCK_NOTICE.slice(0, 20));
    check((await readMessage(page)) === MOCK_NOTICE, `random text -> "${await readMessage(page)}"`);
    check((await bodyRows(page)).length === 0 && (await cards(page)).includes("Orders 0"), "random text: the table stays empty");
    check(!(await page.$eval("#chats", (el) => el.hidden)) && (await page.$eval("#error", (el) => el.hidden)), "random text: the chats stay open, no Error box");
    await page.evaluate(() => scrollTo(0, 0)); // a full-page shot of a scrolled page draws the sticky bars mid-page
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-2-mock-notice.png`, fullPage: true });

    // The demo chats. The reply is held back 600 ms, so we can see the loading state and double-click.
    await page.fill("#chat", DEMO);
    await page.fill("#chat-date", "2026-10-28");
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/api/parse", async (route) => {
      await held;
      await route.continue();
    });
    posts = 0;
    await page.click("#read-orders");
    await page.waitForTimeout(100);
    const loading = await readMessage(page);
    check(loading.startsWith("Reading your messages") && loading.includes("up to a minute"), `loading message: "${loading}"`);
    check(await page.$eval("#read-orders", (el) => el.disabled && el.getAttribute("aria-busy") === "true"), "the button is disabled while reading");
    await page.click("#read-orders", { force: true }).catch(() => {}); // a second click must not send a second parse
    await page.evaluate(() => scrollTo(0, 0)); // a full-page shot of a scrolled page draws the sticky bars mid-page
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-3-reading.png`, fullPage: true });
    setTimeout(release, 500);
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(500); // let the grid finish measuring the rows
    await page.unroute("**/api/parse");
    check(posts === 1, `one parse sent, even after a second click (${posts})`);
    check(!(await page.$eval("#read-orders", (el) => el.disabled)), "the button works again afterwards");

    const buyers = await allBuyers(page);
    check(buyers.length === 9, `the table filled: 9 buyers (${buyers.length})`);
    const summary = await cards(page);
    check(summary.includes("Expected RM 387.00") && summary.includes("Orders 8") && summary.includes("Needs check 1"), `summary cards: "${summary}"`);
    check(await page.$eval("#stat-check", (el) => el.classList.contains("is-check")), "the Needs check card is amber");
    const bar = plain(await page.$eval("#chat-bar", (el) => (el.hidden ? "" : el.innerText)));
    const barDate = viewport.name === "phone" || bar.includes("from 28 Oct"); // phones hide the date on purpose (styles.css)
    check(bar.startsWith("15 messages read") && barDate && bar.endsWith("Edit"), `chats folded into the slim bar: "${bar}"`);
    check(await page.$eval("#chats", (el) => el.hidden), "the chat box is folded away");
    const step = plain(await page.$eval(".steps li.current", (el) => el.innerText));
    check(step.endsWith("Review orders"), `guide moved to step 2: "${step}"`);
    if (viewport.name === "phone") {
      check(plain(await page.$eval("#phone-sum", (el) => el.innerText)) === "Total: 7 orders ready RM 387.00", "phone: the sticky total bar updated");
    } else {
      const pinned = plain(await page.$eval(".ag-grid-pinned-bottom-rows", (el) => el.innerText));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 387.00"), `pinned totals row: "${pinned}"`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-4-read.png`, fullPage: true });

    // Priya: amber row with the "Check:" words (Section 12). Find her page.
    await page.click("#stat-check");
    await page.waitForTimeout(300);
    const priya = page.locator(ROWS, { hasText: "Priya" });
    const priyaText = plain(await priya.innerText());
    check(await priya.evaluate((el) => el.classList.contains("row-unclear")), "Priya's row is amber (unclear)");
    check(priyaText.includes("Needs a check") && priyaText.includes("Check: Cannot determine items"), `Priya needs a check: "${priyaText}"`);
    const stripe = await priya.evaluate((el) => {
      const style = getComputedStyle(el);
      const before = getComputedStyle(el, "::before");
      return { bg: style.backgroundColor, stripe: [style.boxShadow, style.borderLeftColor, before.backgroundColor].join(" ") };
    });
    check(stripe.bg === "rgb(252, 239, 214)" && stripe.stripe.includes("224, 160, 48"), `amber tint #FCEFD6 + amber stripe (${stripe.bg})`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-5-priya.png`, fullPage: true });
    await page.click("#stat-check");
    await page.waitForTimeout(300);

    // ---- Step 5: Send invoices ----
    const SEND = viewport.name === "phone" ? ".phone-total [data-send-invoices]" : "#send-invoices";
    const sendButton = page.locator(SEND);
    check(plain(await sendButton.innerText()) === "Send 7 invoices" && await sendButton.isVisible(), `the Send button: "${plain(await sendButton.innerText())}"`);
    let invoicePosts = 0;
    page.on("request", (req) => req.url().endsWith("/api/invoices") && req.method() === "POST" && invoicePosts++);
    const releasePayPal = fake.hold(); // PayPal "thinks" for a moment, so we can see the waiting state and double-click
    await sendButton.click();
    await page.waitForTimeout(150);
    check(await sendButton.evaluate((el) => el.disabled) && plain(await sendButton.innerText()) === "Sending...", "while sending, the button says Sending... and waits");
    await sendButton.click({ force: true }).catch(() => {});
    setTimeout(releasePayPal, 300);
    await page.waitForFunction(() => document.getElementById("send-message").textContent.includes("sent"));
    await page.waitForTimeout(500);
    const sentMessage = plain(await page.$eval("#send-message", (el) => el.textContent));
    check(sentMessage === "7 invoices sent. Copy each payer link into the chat. Not sent: Priya (needs a check first).", `after sending: "${sentMessage}"`);
    check(invoicePosts === 1 && fake.invoices.size === 7, `one request, 7 invoices at PayPal (requests ${invoicePosts}, invoices ${fake.invoices.size})`);
    check(fake.calls.filter((c) => c.kind === "send").every((c) => c.body.send_to_recipient === false), "sent without emailing anyone");

    const afterSend = await allBuyers(page);
    const withLinks = afterSend.filter((text) => text.includes("Invoice sent") && text.includes("Payer link") && text.includes("Copy link") && text.includes("Sent"));
    check(withLinks.length === 7, `7 buyers show "Invoice sent", the payer link, Copy and the Sent tag (${withLinks.length})`);
    const priyaAfter = afterSend.find((text) => text.includes("Priya")) ?? "";
    check(!priyaAfter.includes("Payer link") && priyaAfter.includes("Check:"), "Priya still needs a check and has no link");
    const step3 = plain(await page.$eval(".steps li.current", (el) => el.innerText));
    check(step3.endsWith("Get paid"), `guide moved to step 3: "${step3}"`);

    // The payer link and Copy: copying fills the clipboard and does NOT open the drawer.
    const lina = page.locator(ROWS, { hasText: "Lina" });
    const href = await lina.locator(".pay-link a").getAttribute("href");
    check(String(href).startsWith("https://www.sandbox.paypal.com/invoice/p/#INV2-"), `Lina's payer link: ${href}`);
    await lina.locator(".copy-link").click();
    await page.waitForTimeout(200);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied === href && plain(await lina.locator(".copy-link").innerText()) === "Copied", "Copy link puts Lina's link on the clipboard and says Copied");
    check(await page.$eval("#drawer", (el) => el.hidden), "clicking Copy does not open the drawer");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6-sent.png`, fullPage: true });

    // Clicking again creates nothing new: the button has nothing left to send, and the server agrees.
    check(await sendButton.evaluate((el) => el.disabled) && plain(await sendButton.innerText()) === "Send invoices", "nothing left to send: the button rests");
    const creates = fake.count("create");
    const again = await page.evaluate(async () => (await fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json());
    check(again.sent.length === 0 && fake.count("create") === creates && fake.invoices.size === 7, "sending again creates nothing new (server check)");

    // Read orders is refused while these invoices exist; the chats still refill on Edit.
    check(await page.locator("#chat-bar [data-new-batch]").isVisible(), "the slim bar offers New batch");
    await page.click("#chat-edit");
    check((await page.inputValue("#chat")).trim() === DEMO.trim(), "Edit opens the chats again, filled with what was read");
    await page.click("#read-orders");
    await page.waitForFunction((text) => document.getElementById("read-message").textContent === text, INVOICED);
    check((await readMessage(page)) === INVOICED && (await allBuyers(page)).length === 9, `Read orders is refused: "${await readMessage(page)}"`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-7-read-refused.png`, fullPage: true });

    // New batch: confirm -> an empty table; then the chats can be read again.
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#chats [data-new-batch]").click();
    await page.waitForSelector(".ag-overlay");
    await page.waitForTimeout(400);
    const emptyAgain = plain(await page.$eval(".ag-overlay", (el) => el.innerText));
    check(emptyAgain.includes("No orders yet") && (await cards(page)).includes("Orders 0"), `New batch: the table is empty again ("${emptyAgain}")`);
    check((await page.inputValue("#chat")) === "" && !(await page.locator("[data-new-batch]").first().isVisible()), "the chat box is empty and New batch hides");
    const step1 = plain(await page.$eval(".steps li.current", (el) => el.innerText));
    check(step1.endsWith("Paste chats"), `guide back at step 1: "${step1}"`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-8-new-batch.png`, fullPage: true });
    await page.fill("#chat", DEMO);
    await page.fill("#chat-date", "2026-10-28");
    await page.click("#read-orders");
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(500);
    check((await allBuyers(page)).length === 9 && plain(await sendButton.innerText()) === "Send 7 invoices", "the new batch reads the chats again: 9 buyers, 7 to send");
    check(fake.invoices.size === 7, "and no invoice was made by reading");

    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.close();
    server.closeAllConnections();
    server.close();
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: all flow checks passed (read, send invoices, new batch).");
process.exitCode = failed ? 1 : 0;
