// The end-to-end check on the HOSTED app (Step 11 part 2), at laptop and phone widths:
//   Load demo -> Read orders -> Send invoices -> record cash for Lina -> Refresh status -> Kitchen list -> Reset demo.
// This one is NOT a fake: it sends REAL sandbox invoices through the live server (7 per width, no emails;
// the buyers are fictional and no real money moves). The keys stay on the server: this script has none.
// It never pays for a Gemini call: every POST /api/parse is stopped unless it is exactly the demo chats and
// date (the server answers those from the saved reply), and the "AI calls left" count must not change.
// It fails on any console error or warning, any failed request, and any sideways scroll.
// Run: npm run ui-live            (or: npm run ui-live -- https://another-url)
// Screenshots go to tmp/screenshots-live/ (git-ignored).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE = (process.argv[2] ?? "https://chatching.onrender.com").replace(/\/$/, "");
const OUT = fileURLToPath(new URL("../tmp/screenshots-live/", import.meta.url));
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const DEMO_DATE = "2026-10-28";
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const SLOW = 90_000; // the real PayPal sandbox, on a small free server

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"
const liveState = async () => (await fetch(`${BASE}/api/state`)).json();
const message = async (page, id) => plain(await page.$eval(id, (el) => el.textContent));
const cards = async (page) => plain(await page.$eval(".summary", (el) => el.innerText));
const bodyRows = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));

async function goToBuyerPage(page, buyer) {
  for (let i = 0; i < 3 && !(await page.locator(ROWS, { hasText: buyer }).count()); i++) {
    const next = !(await page.$eval("#page-next", (el) => el.disabled));
    await page.click(next ? "#page-next" : "#page-prev");
    await page.waitForTimeout(300);
  }
}

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
    console.log(`\n${viewport.width} px (${viewport.name}), ${BASE}`);
    const shot = (step, opts = {}) => page.screenshot({ path: `${OUT}${viewport.width}-${step}.png`, ...opts });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("response", (res) => res.status() >= 400 && errors.push(`HTTP ${res.status()} ${res.url()}`));
    page.on("requestfailed", (req) => errors.push(`failed: ${req.url()} (${req.failure()?.errorText})`));

    // The Gemini guard: only the exact demo chats + date may reach the server's parse route.
    let parses = 0;
    let stopped = 0;
    await page.route("**/api/parse", async (route) => {
      const body = route.request().postDataJSON();
      if (body?.text?.trim() === DEMO.trim() && body.chatDate === DEMO_DATE && !body.withoutAi) {
        parses++;
        return route.continue();
      }
      stopped++;
      return route.abort();
    });

    const aiBefore = (await liveState()).aiCallsLeft;
    const started = Date.now();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#load-demo");
    await page.waitForTimeout(800);
    check(true, `page loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    // Earlier invoices in the table: the app's own New batch keeps them and empties the table.
    const newBatch = page.locator("[data-new-batch]:visible").first();
    if (await newBatch.count()) {
      page.once("dialog", (dialog) => dialog.accept());
      await newBatch.click();
      await page.waitForSelector(".ag-overlay", { timeout: SLOW });
      await page.waitForTimeout(400);
      console.log("note  an earlier batch was in the table: moved aside with New batch");
    }

    // Load demo -> Read orders: from the saved reply, no AI call.
    await page.click("#load-demo");
    await page.waitForFunction(() => document.getElementById("read-message").textContent.includes("Demo chats loaded"), null, { timeout: SLOW });
    check((await page.inputValue("#chat")).trim() === DEMO.trim() && (await page.inputValue("#chat-date")) === DEMO_DATE, "Load demo fills the chats and the Chat date");
    await page.click("#read-orders");
    await page.waitForSelector(ROWS, { timeout: SLOW });
    await page.waitForTimeout(800);
    const buyers = await allBuyers(page);
    const summary = await cards(page);
    check(buyers.length === 10 && summary.includes("Expected RM 366.00") && summary.includes("Needs check 2"), `Read orders: ${buyers.length} buyers; "${summary}"`);
    check(parses === 1 && stopped === 0 && (await liveState()).aiCallsLeft === aiBefore, `no Gemini call: ${parses} demo read, AI calls left still ${aiBefore}`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("1-read", { fullPage: true });

    // Send invoices: real sandbox.
    const SEND = viewport.name === "phone" ? ".phone-total [data-send-invoices]" : "#send-invoices";
    const sendButton = page.locator(SEND);
    check(plain(await sendButton.innerText()) === "Send 7 invoices", `the button: "${plain(await sendButton.innerText())}"`);
    const sendStart = Date.now();
    await sendButton.click();
    await page.waitForFunction(() => /\d of 7 sent/.test(document.getElementById("send-message").textContent), null, { timeout: SLOW * 2 });
    await page.waitForTimeout(800);
    check((await message(page, "#send-message")).startsWith("7 of 7 sent"), `sent in ${((Date.now() - sendStart) / 1000).toFixed(1)} s: "${await message(page, "#send-message")}"`);
    const sent = (await liveState()).orders.filter((row) => row.invoiceId);
    const ids = [...new Set(sent.map((row) => row.invoiceId))];
    check(ids.length === 7 && ids.every((id) => id.startsWith("INV2-")) && sent.every((row) => row.payerLink?.startsWith("https://www.sandbox.paypal.com/")),
      `7 real sandbox invoices with payer links (first: ${ids[0]})`);
    const afterSend = await allBuyers(page);
    check(afterSend.filter((text) => text.includes("Payer link") && text.includes("Copy link")).length === 7, "7 rows show the payer link and Copy");
    await page.evaluate(() => scrollTo(0, 0));
    await shot("2-sent", { fullPage: true });

    // Record cash for Lina in her drawer (the QR code comes from PayPal too).
    await goToBuyerPage(page, "Lina");
    const lina = page.locator(ROWS, { hasText: "Lina" });
    await lina.locator(".chips").click();
    await page.waitForSelector("#drawer.is-open #pay-method", { timeout: SLOW });
    await page.waitForSelector("#qr-image", { timeout: SLOW }).catch(() => {});
    await page.waitForTimeout(800);
    check(await page.$eval("#qr-image", (img) => img.complete && img.naturalWidth > 0).catch(() => false), "her drawer shows PayPal's real QR code");
    check(plain(await page.$eval(".pay-card", (el) => el.innerText)).includes("RM 54.00"), "her drawer offers Record payment for RM 54.00");
    await shot("3-drawer");
    await page.selectOption("#pay-method", "CASH");
    page.once("dialog", (dialog) => dialog.accept());
    await page.click("#record-payment");
    await page.waitForFunction(() => document.getElementById("status-message").textContent.startsWith("Recorded: Lina"), null, { timeout: SLOW });
    check((await message(page, "#status-message")) === "Recorded: Lina paid RM 54.00 by cash.", `"${await message(page, "#status-message")}"`);

    // Refresh status: the server keeps a status for 10 s, so wait past that for a real answer from PayPal.
    await page.waitForTimeout(11_000);
    const refreshed = page.waitForResponse((res) => res.url().endsWith("/api/invoices/refresh"), { timeout: SLOW });
    await page.click("#refresh-status");
    const reply = await (await refreshed).json();
    await page.waitForTimeout(800);
    await goToBuyerPage(page, "Lina");
    const badge = plain(await lina.locator(".badge").innerText());
    const paidCard = plain(await page.$eval("#stat-paid", (el) => el.innerText));
    check(badge === "Paid (cash/bank)" && paidCard.includes("RM 54.00"), `Refresh shows Paid: "${badge}"; "${paidCard}"`);
    check(!reply.notice && !reply.rateLimited, `Refresh answered without a notice${reply.notice ? `: ${reply.notice}` : ""}`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("4-paid", { fullPage: true });

    // Kitchen list.
    await page.click("#kitchen-list");
    await page.waitForSelector("#drawer.is-open .kitchen-day", { timeout: SLOW });
    await page.waitForTimeout(400);
    const days = await page.$$eval(".kitchen-day", (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
    check(days.length === 4 && days[0] === "Thu 29 Oct 2 × Kuih bahulu (pack of 20)" && days[2].startsWith("Sat 31 Oct 6 × Classic brownies (box of 6)") && days[2].endsWith("+2 orders still to check"),
      `Kitchen list: ${JSON.stringify(days)}`);
    await shot("5-kitchen");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");

    // Reset demo.
    page.once("dialog", (dialog) => dialog.accept());
    await page.click("#reset-demo");
    await page.waitForSelector(".ag-overlay", { timeout: SLOW });
    await page.waitForTimeout(500);
    const end = await liveState();
    check((await cards(page)).includes("Orders 0") && end.orders.length === 0, `Reset demo: the table is empty ("${await cards(page)}")`);
    check(end.aiCallsLeft === aiBefore, `AI calls left unchanged at the end (${end.aiCallsLeft})`);
    await shot("6-reset", { fullPage: true });

    check(errors.length === 0, `no console errors, warnings or failed requests${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: the whole flow works on the hosted app.");
process.exitCode = failed ? 1 : 0;
