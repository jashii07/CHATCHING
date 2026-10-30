// The browser check for the whole flow so far, at laptop and phone widths, from an EMPTY table:
//   Step 4: random text -> the friendly mock notice; the demo chats -> loading message, button disabled,
//           table fills, chats fold into the slim bar, summary cards update, Priya and Jun Wei amber.
//   Step 5: Send invoices, one buyer at a time with a real progress bar ("Sending invoice 3 of 7...");
//           one buyer fails (amber "Error:" on that row), the others go on, "6 of 7 sent, 1 needs a retry";
//           retry; the button then says "All invoices sent"; payer links + Copy appear; clicking again
//           creates nothing new; Read orders is refused; New batch empties the table and reading works again.
//   Step 6: a buyer pays -> the 20-second poll turns the row Paid (the page's clock is faked, so no real
//           20 s wait) and flashes green once (not with reduced motion); Refresh status; record cash for
//           Lina in her drawer -> Paid (cash/bank) -> Refresh keeps it; polling pauses after 30 minutes;
//           at the end, Reset demo -> an empty table, with no call to PayPal.
//   Load demo: refused like Read orders while invoices exist; after Reset demo it fills the chat box and
//           date, reads nothing by itself, and Read orders then gives the 10 buyers.
//   Step 10b: Kitchen list opens in the drawer, its numbers match the demo, and Copy gives the plain text.
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
const MOCK_NOTICE = "Mock mode only knows the demo chats. Set AI_MODE=real to read other chats with Gemini.";

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
  // The server's clock can be moved past its 10-second status cache (skip), without waiting.
  let skew = 0;
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, storeFile, paypal, now: () => Date.now() + skew }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, fake, skip: (ms) => (skew += ms) };
}

const bodyRows = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
const cards = async (page) => plain(await page.$eval(".summary", (el) => el.innerText));
const readMessage = async (page) => plain(await page.$eval("#read-message", (el) => el.textContent));

// Go to the page of the table that shows this buyer (the AI decides the order of buyers).
async function goToBuyerPage(page, buyer) {
  for (let i = 0; i < 3 && !(await page.locator(ROWS, { hasText: buyer }).count()); i++) {
    const next = !(await page.$eval("#page-next", (el) => el.disabled));
    await page.click(next ? "#page-next" : "#page-prev");
    await page.waitForTimeout(300);
  }
}

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
    const { server, fake, skip } = await startServer(viewport.name);
    const base = `http://localhost:${server.address().port}`;
    const page = await browser.newPage({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
    const errors = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    let posts = 0;
    page.on("request", (req) => req.url().endsWith("/api/parse") && req.method() === "POST" && posts++);

    console.log(`\n${viewport.width} px (${viewport.name})`);
    await page.clock.install(); // the page's timers run normally, but we can jump ahead (polling)
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
    check(loading === "Reading the chats...", `loading message: "${loading}"`);
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
    check(buyers.length === 10, `the table filled: 10 buyers (${buyers.length})`);
    const summary = await cards(page);
    check(summary.includes("Expected RM 366.00") && summary.includes("Orders 9") && summary.includes("Needs check 2"), `summary cards: "${summary}"`);
    check(await page.$eval("#stat-check", (el) => el.classList.contains("is-check")), "the Needs check card is amber");
    const bar = plain(await page.$eval("#chat-bar", (el) => (el.hidden ? "" : el.innerText)));
    const barDate = viewport.name === "phone" || bar.includes("from 28 Oct"); // phones hide the date on purpose (styles.css)
    check(bar.startsWith("18 messages read") && barDate && bar.endsWith("Edit"), `chats folded into the slim bar: "${bar}"`);
    check(await page.$eval("#chats", (el) => el.hidden), "the chat box is folded away");
    const step = plain(await page.$eval(".steps li.current", (el) => el.innerText));
    check(step.endsWith("Review orders"), `guide moved to step 2: "${step}"`);
    if (viewport.name === "phone") {
      check(plain(await page.$eval("#phone-sum", (el) => el.innerText)) === "Total: 7 orders ready RM 366.00", "phone: the sticky total bar updated");
    } else {
      const pinned = plain(await page.$eval(".ag-grid-pinned-bottom-rows", (el) => el.innerText));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 366.00"), `pinned totals row: "${pinned}"`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-4-read.png`, fullPage: true });

    // Priya: amber row with the "Check:" words (Section 12). Find her page.
    await page.click("#stat-check");
    await page.waitForTimeout(300);
    const priya = page.locator(ROWS, { hasText: "Priya" });
    const priyaText = plain(await priya.innerText());
    check(await priya.evaluate((el) => el.classList.contains("row-unclear")), "Priya's row is amber (unclear)");
    check(priyaText.includes("Needs a check") && priyaText.includes("Check: Which brownies: classic or cheese?"), `Priya needs a check: "${priyaText}"`);
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
    fake.slow("send", 300); // each invoice takes a moment, so the bar can be seen moving
    // Arif (5th in the table) fails once at PayPal; the others must carry on.
    fake.failNext("create", 500, { name: "INTERNAL_SERVER_ERROR", message: "Try again later." }, ({ body }) => body?.detail?.invoice_number?.endsWith("-05"));
    const progress = async () => page.$eval("#send-progress", (el) => ({
      hidden: el.hidden, now: Number(el.getAttribute("aria-valuenow")), max: Number(el.getAttribute("aria-valuemax")),
      width: el.querySelector("span").getBoundingClientRect().width / el.getBoundingClientRect().width,
    }));
    await sendButton.click();
    await page.waitForFunction(() => document.getElementById("send-message").textContent.startsWith("Sending invoice 3 of 7"), null, { timeout: 10000 });
    const mid = await progress();
    const midText = plain(await page.$eval("#send-message", (el) => el.textContent));
    // Buyer 3's draft may already exist at PayPal; "done" means really sent (UNPAID).
    const sentAtPayPal = [...fake.invoices.values()].filter((inv) => inv.status === "UNPAID").length;
    check(!mid.hidden && mid.max === 7 && mid.now === 2 && sentAtPayPal === 2, `mid-send: "${midText}", the bar counts REAL results (${mid.now} of ${mid.max} done, ${sentAtPayPal} sent at PayPal)`);
    check(await sendButton.evaluate((el) => el.disabled) && plain(await sendButton.innerText()) === "Sending 3 of 7...", `the button waits and counts: "${plain(await sendButton.innerText())}"`);
    await sendButton.click({ force: true }).catch(() => {}); // a click while sending does nothing
    await page.waitForTimeout(300); // let the bar finish easing to its new length
    await page.evaluate(() => scrollTo(0, document.getElementById("send-progress").getBoundingClientRect().top + scrollY - 200));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-5b-sending.png` });
    await page.waitForFunction(() => /\d of 7 sent/.test(document.getElementById("send-message").textContent), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    const done = await progress();
    const doneText = plain(await page.$eval("#send-message", (el) => el.textContent));
    check(doneText === "6 of 7 sent, 1 needs a retry. Not sent: Priya, Jun Wei (need a check first).", `one failure doesn't stop the others: "${doneText}"`);
    check(done.now === 7 && done.width > 0.98, `the bar still finishes (${done.now} of ${done.max})`);
    check(invoicePosts === 7 && fake.invoices.size === 6, `one request per buyer, the extra click sent nothing (requests ${invoicePosts}, invoices ${fake.invoices.size})`);
    await goToBuyerPage(page, "Arif");
    const arifRow = page.locator(ROWS, { hasText: "Arif" });
    const arifText = plain(await arifRow.innerText());
    check(arifText.includes("Error: PayPal could not create the invoice (HTTP 500, INTERNAL_SERVER_ERROR)") && await arifRow.evaluate((el) => el.classList.contains("row-unclear")),
      `Arif's row shows the amber Error: message: "${arifText}"`);
    check(plain(await sendButton.innerText()) === "Send 1 invoice" && !(await sendButton.evaluate((el) => el.disabled)), "the button offers the retry: Send 1 invoice");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-5c-one-failed.png`, fullPage: true });
    // With reduced motion the bar doesn't animate (the words still count).
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await page.$eval("#send-progress span", (el) => getComputedStyle(el).transitionDuration);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const moving = await page.$eval("#send-progress span", (el) => getComputedStyle(el).transitionDuration);
    check(still === "0s" && moving !== "0s", `reduced motion: the bar doesn't animate (${still} vs ${moving})`);
    // Retry Arif.
    await sendButton.click();
    await page.waitForFunction(() => document.getElementById("send-message").textContent.startsWith("1 of 1 sent"), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const sentMessage = plain(await page.$eval("#send-message", (el) => el.textContent));
    check(sentMessage === "1 of 1 sent. Copy each payer link into the chat. Not sent: Priya, Jun Wei (need a check first).", `the retry: "${sentMessage}"`);
    check(fake.invoices.size === 7 && !plain(await page.locator(ROWS, { hasText: "Arif" }).innerText()).includes("Error:"), "Arif is sent and his Error: is gone (7 invoices at PayPal)");
    check(fake.calls.filter((c) => c.kind === "send").every((c) => c.body.send_to_recipient === false), "sent without emailing anyone");
    fake.slow("send", 0);

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

    // ---- Step 10: ready-to-send texts, built by code (no AI). Exact text on the clipboard. ----
    const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
    const linaMessage = `Hi Lina! Your order: 3 x Classic brownies (RM 54.00), delivery Sat 31 Oct. Pay here: ${href}. Thank you!`;
    await lina.locator('.copy-text[data-kind="message"]').click();
    await page.waitForTimeout(200);
    const copiedMessage = await clipboard();
    check(copiedMessage === linaMessage && plain(await lina.locator('.copy-text[data-kind="message"]').innerText()) === "Copied",
      `Copy message (in her row): ${JSON.stringify(copiedMessage)}`);
    check(await page.$eval("#drawer", (el) => el.hidden), "Copy message does not open the drawer");
    await lina.locator(".chips").click();
    await page.waitForSelector("#drawer.is-open #copy-reminder");
    await page.waitForTimeout(300);
    check((await page.$eval("#text-message", (el) => el.textContent)) === linaMessage, "her drawer shows the same message in full");
    await page.click("#copy-reminder");
    await page.waitForTimeout(200);
    const copiedReminder = await clipboard();
    check(copiedReminder === `Hi Lina! A gentle reminder that your order (RM 54.00) is still unpaid. Pay here: ${href}. Thank you!`,
      `Copy reminder (in her drawer): ${JSON.stringify(copiedReminder)}`);
    await page.$eval("#drawer .text-card", (el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6c-texts.png` });
    await page.keyboard.press("Escape");
    await goToBuyerPage(page, "Priya");
    const priyaRow = page.locator(ROWS, { hasText: "Priya" });
    await priyaRow.locator('.copy-text[data-kind="question"]').click();
    await page.waitForTimeout(200);
    const copiedQuestion = await clipboard();
    check(copiedQuestion === "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?", `Copy question (Priya's row): ${JSON.stringify(copiedQuestion)}`);
    await goToBuyerPage(page, "Jun Wei");
    await page.locator(ROWS, { hasText: "Jun Wei" }).locator(".chips").click();
    await page.waitForSelector("#drawer.is-open #copy-question");
    await page.click("#copy-question");
    await page.waitForTimeout(200);
    const junQuestion = await clipboard();
    check(junQuestion === "Hi Jun Wei! Just to check: Classic brownies are RM 18.00 each, so your total is RM 62.00. Is that ok?",
      `Copy question (Jun Wei's drawer, price mismatch): ${JSON.stringify(junQuestion)}`);
    check(!(await page.$("#copy-message")) && !(await page.$("#copy-reminder")), "no invoice yet, so no message or reminder for Jun Wei");
    await page.keyboard.press("Escape");
    await goToBuyerPage(page, "Lina");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6-sent.png`, fullPage: true });

    // Step 7: once sent, Arif's drawer shows his messages AND the invoice's QR code from PayPal.
    await goToBuyerPage(page, "Arif");
    const qrBefore = fake.count("qr");
    await page.locator(ROWS, { hasText: "Arif" }).click();
    await page.waitForSelector("#drawer.is-open #qr-image", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const qrShown = await page.$eval("#qr-image", (img) => img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width === 180).catch(() => false);
    const qrCard = plain(await page.$eval("#drawer .qr-card", (el) => el.innerText).catch(() => ""));
    check(qrShown && qrCard.startsWith("QR code for this invoice") && fake.count("qr") === qrBefore + 1, `Arif's drawer shows the PayPal QR code (one PayPal call): "${qrCard}"`);
    check(await page.$eval("#drawer .chat-card", (el) => el.innerText.includes("What Arif wrote")), "and still starts with what he wrote");
    await page.$eval("#drawer .qr-card", (el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6b-qr.png` });
    await page.keyboard.press("Escape");
    await page.locator(ROWS, { hasText: "Arif" }).click();
    await page.waitForSelector("#drawer.is-open #qr-image");
    check(fake.count("qr") === qrBefore + 1, "opening his drawer again asks PayPal for nothing new (the QR code is kept)");
    await page.keyboard.press("Escape");
    await goToBuyerPage(page, "Lina");

    // Clicking again creates nothing new: the button has nothing left to send, and the server agrees.
    check(await sendButton.evaluate((el) => el.disabled) && plain(await sendButton.innerText()) === "All invoices sent", `nothing left to send: "${plain(await sendButton.innerText())}" (disabled)`);
    const creates = fake.count("create");
    const again = await page.evaluate(async () => (await fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json());
    check(again.sent.length === 0 && fake.count("create") === creates && fake.invoices.size === 7, "sending again creates nothing new (server check)");

    // ---- Step 6: who has paid ----
    const idOf = async (buyer) => (await (await fetch(`${base}/api/state`)).json()).orders.find((row) => row.buyer === buyer).invoiceId;
    const statusOf = async (buyer) => plain(await page.locator(ROWS, { hasText: buyer }).locator(".badge").innerText());
    check(await page.locator("#refresh-status").isVisible(), "Refresh status shows once invoices exist");
    // Hafiz pays in the sandbox; 20 s later the page's own poll notices (no click).
    fake.pay(await idOf("Hafiz"));
    skip(11_000);
    await page.clock.fastForward(20_000);
    await page.waitForFunction(() => document.getElementById("status-message").textContent.includes("Paid: Hafiz"), null, { timeout: 5000 }).catch(() => {});
    check((await statusOf("Hafiz")) === "Paid", `the 20-second poll turned Hafiz Paid by itself ("${await statusOf("Hafiz")}")`);
    const flashing = (buyer) => page.locator(ROWS, { hasText: buyer }).locator(".ag-cell-data-changed, .ag-cell-data-changed-animation").count();
    check((await flashing("Hafiz")) > 0, "Hafiz's status flashes green once");
    const paidCard = plain(await page.$eval("#stat-paid", (el) => el.innerText));
    check(paidCard.includes("RM 45.00") && await page.$eval("#stat-paid", (el) => el.classList.contains("is-paid")), `the Paid card turned green: "${paidCard}"`);
    const paidTag = await page.locator(ROWS, { hasText: "Hafiz" }).locator(".badge").evaluate((el) => getComputedStyle(el).backgroundColor);
    check(paidTag === "rgb(220, 242, 227)", `the Paid tag is the green tint #DCF2E3 (${paidTag}); Sent stays neutral`);
    // Mei Ling pays; Refresh status asks at once.
    fake.pay(await idOf("Mei Ling"));
    skip(11_000);
    await page.emulateMedia({ reducedMotion: "reduce" }); // this seller turned animations off
    await page.click("#refresh-status");
    await page.waitForFunction(() => document.getElementById("status-message").textContent.includes("Paid: Mei Ling"), null, { timeout: 5000 }).catch(() => {});
    check((await flashing("Mei Ling")) === 0, "with reduced motion on, Mei Ling turns Paid without a flash");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const statusLine = plain(await page.$eval("#status-message", (el) => el.textContent));
    check((await statusOf("Mei Ling")) === "Paid" && statusLine.includes("Checking again every 20 seconds"), `Refresh status: "${statusLine}"`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6b-paid.png`, fullPage: true });
    // A hidden tab doesn't poll; when it is visible again, the next tick asks.
    fake.pay(await idOf("Arif"));
    skip(11_000);
    const setVisibility = (state) => page.evaluate((s) => Object.defineProperty(document, "visibilityState", { value: s, configurable: true }), state);
    await setVisibility("hidden");
    const getsHidden = fake.calls.filter((c) => c.kind === "get").length;
    await page.clock.fastForward(20_000);
    await page.waitForTimeout(300);
    check(fake.calls.filter((c) => c.kind === "get").length === getsHidden && (await statusOf("Arif")) === "Sent", "a hidden tab doesn't ask PayPal");
    await setVisibility("visible");
    await page.clock.fastForward(20_000);
    await page.waitForFunction(() => document.getElementById("status-message").textContent.includes("Paid: Arif"), null, { timeout: 5000 }).catch(() => {});
    check((await statusOf("Arif")) === "Paid", "visible again: the next poll turns Arif Paid");
    // Lina pays cash at pickup: record it in her drawer. The amount is shown, never typed.
    await goToBuyerPage(page, "Lina");
    await page.locator(ROWS, { hasText: "Lina" }).locator(".chips").click();
    await page.waitForSelector("#drawer.is-open");
    await page.waitForTimeout(400);
    const payCard = plain(await page.$eval(".pay-card", (el) => el.innerText).catch(() => ""));
    check(payCard.includes("Paid by cash or bank transfer?") && payCard.includes("RM 54.00") && !(await page.$(".pay-card input")),
      `Lina's drawer offers Record payment for RM 54.00, with no amount box: "${payCard}"`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6c-record-cash.png` });
    await page.selectOption("#pay-method", "CASH");
    page.once("dialog", (dialog) => dialog.accept());
    await page.click("#record-payment");
    await page.waitForFunction(() => document.getElementById("status-message").textContent.startsWith("Recorded: Lina"), null, { timeout: 5000 }).catch(() => {});
    check(await page.$eval("#drawer", (el) => el.hidden), "after recording, the drawer closes so the row is seen");
    check((await statusOf("Lina")) === "Paid (cash/bank)" && (await flashing("Lina")) > 0, `Lina turns "Paid (cash/bank)" and flashes green (${await statusOf("Lina")})`);
    const linaId = await idOf("Lina");
    const cashCall = fake.calls.find((c) => c.kind === "payment");
    check(fake.invoices.get(linaId).status === "MARKED_AS_PAID" && cashCall?.body.method === "CASH" && cashCall.body.amount.value === "54.00",
      "PayPal recorded CASH for the full 54.00 (MARKED_AS_PAID)");
    const msg = plain(await page.$eval("#status-message", (el) => el.textContent));
    check(msg === "Recorded: Lina paid RM 54.00 by cash.", `message: "${msg}"`);
    const twice = await page.evaluate(async (id) => (await fetch(`/api/invoices/${id}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"method":"CASH"}' })).status, linaId);
    check(twice === 409 && fake.calls.filter((c) => c.kind === "payment").length === 1, `recording twice is refused by the server (HTTP ${twice})`);
    errors.splice(0, errors.length, ...errors.filter((e) => !e.includes("409"))); // that refusal was on purpose
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-6d-cash-paid.png`, fullPage: true });
    skip(11_000);
    await page.click("#refresh-status");
    await page.waitForTimeout(500);
    check((await statusOf("Lina")) === "Paid (cash/bank)" && (await statusOf("Hafiz")) === "Paid", "Refresh after the cash payment: Lina stays Paid (cash/bank)");

    // 30 minutes later the polling stops by itself.
    const getsBefore = fake.calls.filter((c) => c.kind === "get").length;
    await page.clock.fastForward(31 * 60_000);
    await page.waitForTimeout(300);
    const paused = plain(await page.$eval("#status-message", (el) => el.textContent));
    check(paused.startsWith("Auto-check paused after 30 minutes"), `polling pauses after 30 minutes: "${paused}"`);
    await page.clock.fastForward(5 * 60_000);
    await page.waitForTimeout(300);
    check(fake.calls.filter((c) => c.kind === "get").length === getsBefore, "after the pause, no more PayPal checks");

    // Read orders is refused while these invoices exist; the chats still refill on Edit.
    check(await page.locator("#chat-bar [data-new-batch]").isVisible(), "the slim bar offers New batch");
    await page.click("#chat-edit");
    check((await page.inputValue("#chat")).trim() === DEMO.trim(), "Edit opens the chats again, filled with what was read");
    await page.click("#read-orders");
    await page.waitForFunction((text) => document.getElementById("read-message").textContent === text, INVOICED);
    check((await readMessage(page)) === INVOICED && (await allBuyers(page)).length === 10, `Read orders is refused: "${await readMessage(page)}"`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-7-read-refused.png`, fullPage: true });
    await page.fill("#chat", "kept as it is");
    await page.click("#load-demo");
    await page.waitForTimeout(300);
    check((await readMessage(page)) === INVOICED && (await page.inputValue("#chat")) === "kept as it is",
      "Load demo follows the batch rule while invoices exist: same notice, the chat box is left alone");

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
    check((await allBuyers(page)).length === 10 && plain(await sendButton.innerText()) === "Send 7 invoices", "the new batch reads the chats again: 10 buyers, 7 to send");
    check(fake.invoices.size === 7, "and no invoice was made by reading");

    // ---- Reset demo (with sent invoices in the table) ----
    await sendButton.click();
    await page.waitForFunction(() => document.getElementById("send-message").textContent.includes("7 of 7 sent"), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    const invoicesBefore = fake.invoices.size;
    const callsBefore = fake.calls.length;
    page.once("dialog", (dialog) => {
      check(dialog.message().includes("Nothing in PayPal is deleted or cancelled"), `Reset asks first: "${dialog.message()}"`);
      dialog.accept();
    });
    await page.click("#reset-demo");
    await page.waitForSelector(".ag-overlay");
    await page.waitForTimeout(400);
    const afterReset = plain(await page.$eval(".ag-overlay", (el) => el.innerText));
    check(afterReset.includes("No orders yet") && (await cards(page)).includes("Orders 0") && (await cards(page)).includes("Paid RM 0.00"),
      `Reset demo: the table is empty ("${afterReset}")`);
    check(fake.calls.length === callsBefore && fake.invoices.size === invoicesBefore, "Reset made no PayPal call and deleted nothing");
    const savedFile = JSON.parse(readFileSync(`${OUT}${viewport.name}-orders.json`, "utf8"));
    check(savedFile.rows.length === 0 && savedFile.source === null, "the saved orders file is cleared");
    check((await page.inputValue("#chat")) === "" && !(await page.locator("#chats").isHidden()), "the chat box is open and empty, ready for a new paste");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-9-reset.png`, fullPage: true });

    // ---- Load demo after Reset: fills the box, reads nothing; Read orders does the reading ----
    const loadDemo = page.locator("#load-demo");
    const fits = await loadDemo.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const read = document.getElementById("read-orders").getBoundingClientRect();
      return box.right <= innerWidth && box.height >= 44 && box.width >= 44 && Math.abs(box.top - read.top) < 80;
    });
    check(await loadDemo.isVisible() && fits, "Load demo sits next to Read orders, fits the screen, and is at least 44 px");
    const parseBefore = fake.calls.length;
    await loadDemo.click();
    await page.waitForTimeout(300);
    const loaded = await readMessage(page);
    check((await page.inputValue("#chat")) === DEMO && (await page.inputValue("#chat-date")) === "2026-10-28",
      "Load demo fills the chat box with the demo chats and the Chat date 2026-10-28");
    check(loaded === "Demo chats loaded: 18 messages from Wed 28 Oct. Click Read orders." && (await cards(page)).includes("Orders 0"),
      `it reads nothing by itself: "${loaded}"`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-10-demo-loaded.png`, fullPage: true });
    await page.click("#read-orders");
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(500);
    check((await allBuyers(page)).length === 10 && (await cards(page)).includes("Expected RM 366.00"), "Read orders after Load demo: 10 buyers, RM 366.00 expected");
    check(fake.calls.length === parseBefore, "Load demo + Read orders made no PayPal call");

    // ---- Step 10b: Kitchen list -> the numbers match the demo -> Copy gives the plain text ----
    await page.click("#kitchen-list");
    await page.waitForSelector("#drawer.is-open");
    await page.waitForTimeout(300); // the slide-in
    const days = await page.$$eval(".kitchen-day", (cards) => cards.map((card) => card.innerText.replace(/\s+/g, " ").trim()));
    check(plain(await page.$eval("#drawer-title", (el) => el.textContent)) === "Kitchen list", "Kitchen list opens in the drawer");
    check(days.length === 4 && days[0] === "Thu 29 Oct 2 × Kuih bahulu (pack of 20)" && days[1] === "Fri 30 Oct 1 × Burnt cheesecake 6-inch"
      && days[2] === "Sat 31 Oct 6 × Classic brownies (box of 6) 1 × Cheese brownies (box of 6) 1 × Burnt cheesecake 6-inch 2 × Choc chip cookies (jar) +2 orders still to check"
      && days[3] === "Sun 1 Nov 6 × Kuih bahulu (pack of 20)", `kitchen numbers match the demo: ${JSON.stringify(days)}`);
    const drawerFits = await page.$eval("#drawer", (el) => el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth);
    check(drawerFits, "the kitchen list fits the screen (no sideways scroll)");
    check(await page.evaluate(() => document.activeElement?.id === "copy-kitchen"), "focus starts on Copy");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-11-kitchen.png` });
    await page.click("#copy-kitchen");
    await page.waitForTimeout(200);
    // Windows' clipboard stores line breaks as \r\n; the app copies \n (both paste the same).
    const kitchenText = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
    const kitchenWant = (await (await fetch(`${base}/api/state`)).json()).kitchen.text;
    check(kitchenText === kitchenWant && kitchenText.startsWith("Kitchen list\n\nThu 29 Oct\n2 x Kuih bahulu (pack of 20)\n")
      && kitchenText.includes("\n+2 orders still to check\n"), `Copy puts the kitchen list on the clipboard as plain text${kitchenText === kitchenWant ? "" : `: ${JSON.stringify(kitchenText)}`}`);
    check(plain(await page.$eval("#copy-kitchen", (el) => el.innerText)) === "Copied", "the button says Copied");
    await page.keyboard.press("Escape");
    check(await page.$eval("#drawer", (el) => el.hidden), "Escape closes the kitchen list");

    // ---- Add / remove items in the drawer: Read without AI -> fix Hafiz -> send -> his items are locked ----
    // The demo chats on another Chat date: mock mode doesn't know them, so the notice offers Read without AI.
    await page.click("#chat-edit");
    await page.fill("#chat-date", "2026-10-29");
    await page.click("#read-orders");
    await page.waitForSelector("#read-without-ai:not([hidden])", { timeout: 5000 }).catch(() => {});
    await page.click("#read-without-ai");
    await page.waitForSelector("#fallback-note:not([hidden])", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const stateNow = async () => (await fetch(`${base}/api/state`)).json();
    const hafizRows = async () => (await stateNow()).orders.filter((row) => row.buyer === "Hafiz");
    const [, hafizCookies] = await hafizRows();
    await goToBuyerPage(page, "Hafiz");
    const hafizRow = () => page.locator(ROWS, { hasText: "Hafiz" });
    check(await hafizRow().evaluate((el) => el.classList.contains("row-unclear")), "read without AI, Hafiz is amber (cheesecake + the cookies he took back)");
    await hafizRow().locator(".chips").click();
    await page.waitForSelector("#drawer.is-open");
    await page.waitForTimeout(300);
    check((await page.locator("#drawer .remove-item").count()) === 2 && (await page.locator("#add-item").count()) === 1, "his drawer has Remove item on both items and an Add item card");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-12-hafiz-before.png` });

    // Add, then remove again: the price comes from the menu.
    await page.selectOption("#add-item-select", "bahulu");
    await page.fill("#add-item-qty", "2");
    await page.click("#add-item");
    await page.waitForFunction(() => document.querySelectorAll("#drawer .remove-item").length === 3, null, { timeout: 5000 }).catch(() => {});
    const added = (await hafizRows()).find((row) => row.itemId === "bahulu");
    check(added?.qty === 2 && added.lineTotal === "24.00" && (await page.locator("#drawer .edit-name", { hasText: "Kuih bahulu" }).count()) === 1,
      `Add item: 2 × Kuih bahulu at the menu price (${added?.lineTotal})`);
    await page.click(`#remove-${added.id}`);
    await page.waitForFunction(() => document.querySelectorAll("#drawer .remove-item").length === 2, null, { timeout: 5000 }).catch(() => {});

    // Remove the cookies: Hafiz becomes clear and can be invoiced.
    await page.click(`#remove-${hafizCookies.id}`);
    await page.waitForFunction(() => document.querySelectorAll("#drawer .remove-item").length === 1, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const hafizSub = plain(await page.$eval("#drawer-sub", (el) => el.textContent));
    check(hafizSub === "1 item, RM 45.00 in total" && !(await page.$("#drawer-body .check-text")), `cookies removed: Hafiz is clear: "${hafizSub}"`);
    check((await hafizRows()).map((row) => row.itemId).join() === "burnt_cheesecake", "the server keeps only his cheesecake");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-12-hafiz-after.png` });
    await page.keyboard.press("Escape");
    check(!(await hafizRow().evaluate((el) => el.classList.contains("row-unclear"))) && plain(await hafizRow().innerText()).includes("RM 45.00"),
      "his row is no longer amber and shows RM 45.00");
    check(plain(await page.$eval(".summary", (el) => el.innerText)).includes("Expected RM 117.00"), "Expected: Mei Ling 72.00 + Hafiz 45.00 = RM 117.00");

    // Lina's only item: removing it asks to cancel her order first.
    await goToBuyerPage(page, "Lina");
    await page.locator(ROWS, { hasText: "Lina" }).locator(".chips").click();
    await page.waitForSelector("#drawer.is-open .remove-item");
    let asked = "";
    page.once("dialog", (dialog) => ((asked = dialog.message()), dialog.accept()));
    await page.click("#drawer .remove-item");
    await page.waitForFunction(() => document.getElementById("drawer-sub").textContent === "Cancelled order", null, { timeout: 5000 }).catch(() => {});
    check(asked.startsWith("Cancel this buyer's order?"), `the last item asks first: "${asked}"`);
    check(plain(await page.$eval("#drawer-sub", (el) => el.textContent)) === "Cancelled order" && !(await page.$("#drawer .remove-item")), "Lina's order is cancelled (no more Remove or Add)");
    await page.keyboard.press("Escape");

    // Send: Mei Ling + Hafiz. Then Hafiz's items are locked, in the drawer AND at the server.
    await page.locator("[data-send-invoices]:visible").first().click();
    await page.waitForFunction(() => document.getElementById("send-message").textContent.startsWith("2 of 2 sent"), null, { timeout: 10000 }).catch(() => {});
    check(plain(await page.$eval("#send-message", (el) => el.textContent)).startsWith("2 of 2 sent"), `sent: "${plain(await page.$eval("#send-message", (el) => el.textContent))}"`);
    await goToBuyerPage(page, "Hafiz");
    await hafizRow().locator(".chips").click();
    await page.waitForSelector("#drawer.is-open");
    await page.waitForTimeout(300);
    const lockedText = plain(await page.$eval("#drawer .locked-note", (el) => el.textContent).catch(() => ""));
    check(lockedText === "Invoice sent: items are locked so the invoice and the table always match.", `his drawer says why: "${lockedText}"`);
    check(!(await page.$("#drawer .remove-item")) && !(await page.$("#add-item")) && (await page.$$eval("#drawer [data-field]", (els) => els.length > 0 && els.every((el) => el.disabled))),
      "no Remove item, no Add item, and the item fields are disabled");
    // Asked from here, not from the page: a refused request would be a red console error there.
    const refusedRemove = await (await fetch(`${base}/api/orders/${(await hafizRows())[0].id}`, { method: "DELETE" })).json();
    check(refusedRemove.error === lockedText, `the server refuses too: "${refusedRemove.error}"`);
    await page.$eval("#drawer .locked-note", (el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-13-locked.png` });
    await page.keyboard.press("Escape");

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
