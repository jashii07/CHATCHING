// The end-to-end check on the HOSTED app (Step 11 part 2), at laptop and phone widths:
//   Load demo -> Read orders -> Send invoices -> Open on my phone -> the paired phone scans Aisyah's real QR ->
//   Collected shows on the laptop -> Save QR + record cash for Lina -> Refresh status -> Kitchen list -> Reset demo.
// The pickup scan uses Chromium's fake camera, playing the QR image PayPal just made for that invoice: a real
// QR, the real status from the sandbox, and a real cash payment. Only the camera itself is pretend.
// This one is NOT a fake: it sends REAL sandbox invoices through the live server (7 per width, no emails;
// the buyers are fictional and no real money moves). The keys stay on the server: this script has none.
// It never pays for a Gemini call: every POST /api/parse is stopped unless it is exactly the demo chats and
// date (the server answers those from the saved reply), and the "AI calls left" count must not change.
// It fails on any console error or warning, any failed request, and any sideways scroll.
// First it checks that the version in package.json is really live, so it can never pass on an old deploy.
// Each width is a new browser, so a new visitor with a new empty table; a second browser checks mid-way that
// another visitor sees none of it.
// Run: npm run ui-live            (or: npm run ui-live -- https://another-url)
// Screenshots go to tmp/screenshots-live/ (git-ignored).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { VISITOR_COOKIE, isVisitorId } from "../src/visitors.js";
import { cameraArgs, readQrOnScreen, writeCameraFile } from "./fake-camera.mjs";

const BASE = (process.argv[2] ?? "https://chatching.onrender.com").replace(/\/$/, "");
const OUT = fileURLToPath(new URL("../tmp/screenshots-live/", import.meta.url));
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const DEMO_DATE = "2026-10-28";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const PHONE = { width: 390, height: 844 };
const SLOW = 90_000; // the real PayPal sandbox, on a small free server
const PAIR_HELP = "Scan this with your phone to open the same orders. Works once, for 10 minutes.";
const PAIR_EXPIRED = "This link has expired. Make a new one on your laptop.";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"
const liveState = async (page) => (await page.request.get(`${BASE}/api/state`)).json(); // with this browser's cookie
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
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok === true && health.version === version, `the live server runs version ${health.version} (package.json: ${version})`);
  if (health.version !== version) throw new Error("The new version is not live yet. Wait for Render to finish deploying, then run this again.");

  // The security headers really arrive through Render's proxy, and another site's request is refused.
  console.log("\nSecurity headers");
  for (const path of ["/", "/pair", "/order", "/app.js", "/api/health"]) {
    const { headers } = await fetch(`${BASE}${path}`);
    const policy = headers.get("content-security-policy") ?? "";
    check(policy.includes("frame-ancestors 'none'") && policy.includes("script-src 'self';") && !policy.includes("unsafe-eval"), `${path}: Content-Security-Policy`);
    check(headers.get("x-content-type-options") === "nosniff", `${path}: X-Content-Type-Options`);
    check(headers.get("referrer-policy") === "same-origin", `${path}: Referrer-Policy`);
    check(headers.get("permissions-policy")?.includes("camera=(self)"), `${path}: Permissions-Policy`);
  }
  const page0 = await fetch(BASE);
  console.log(`      Render adds HSTS: ${page0.headers.get("strict-transport-security") ?? "no"}`);
  const forged = await fetch(`${BASE}/api/reset`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  check(forged.status === 403, `a POST from another website is refused (${forged.status})`);

  for (const viewport of WIDTHS) {
    console.log(`\n${viewport.width} px (${viewport.name}), ${BASE}`);
    const shot = (step, opts = {}) => page.screenshot({ path: `${OUT}${viewport.width}-${step}.png`, ...opts });
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("response", (res) => res.status() >= 400 && errors.push(`HTTP ${res.status()} ${res.url()}`));
    page.on("requestfailed", (req) => errors.push(`failed: ${req.url()} (${req.failure()?.errorText})`));
    // Nothing the seller's page loads comes from another site (6 Nov: AG Grid and Lucide are served by the app).
    const outside = new Set();
    page.on("request", (req) => req.frame() === page.mainFrame() && !/^(data|blob):/.test(req.url()) && new URL(req.url()).origin !== new URL(BASE).origin && outside.add(new URL(req.url()).origin));

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

    const started = Date.now();
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#load-demo");
    await page.waitForTimeout(800);
    check(true, `page loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const aiBefore = (await liveState(page)).aiCallsLeft;

    // A new visitor: their own empty table, with the chat box open and Load demo in view; a safe cookie.
    check((await cards(page)).includes("Orders 0") && (await page.locator("#chat").isVisible()) && (await page.locator("#load-demo").isVisible()), "a new visitor: an empty table, the chat box open, Load demo visible");
    // The guide's next-step card (6 Nov): on an empty table it is the starter card, on the first screen.
    const starter = await page.$eval("#next-step", (el) => ({ shown: !el.hidden, inFirstScreen: el.getBoundingClientRect().bottom <= innerHeight, words: el.innerText.replace(/\s+/g, " ").trim() })).catch(() => ({}));
    check(starter.shown && starter.inFirstScreen && starter.words === "New here? Try the demo, or paste your chats below, then click Read orders. Try the demo", `the starter card is on the first screen: ${JSON.stringify(starter)}`);
    await shot("0-first-screen");
    const cookie = (await page.context().cookies()).find((c) => c.name === VISITOR_COOKIE);
    check(isVisitorId(cookie?.value) && cookie.httpOnly && cookie.secure && cookie.sameSite === "Lax", "the visitor cookie is HttpOnly, Secure and SameSite=Lax");

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
    check(parses === 1 && stopped === 0 && (await liveState(page)).aiCallsLeft === aiBefore, `no Gemini call: ${parses} demo read, AI calls left still ${aiBefore}`);
    const nextLine = async () => plain(await page.$eval("#next-text", (el) => el.textContent));
    check((await nextLine()).startsWith("Next: fix the amber rows") && buyers.filter((text) => text.includes("Not sent")).length === 9 && !buyers.some((text) => /\bDraft\b/.test(text)),
      `the guide says what's next ("${await nextLine()}"); 9 buyers say Not sent, none say Draft`);
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
    const banner = await page.$eval("#sent-banner", (el) => (el.hidden ? "" : el.innerText.replace(/\s+/g, " ").trim()));
    check(banner.startsWith("Invoices sent. Now send each buyer their message.") && (await nextLine()).startsWith("Next: send each buyer their message."),
      `right after sending, the banner and the guide say to send each buyer their message: "${banner}"`);
    const sent = (await liveState(page)).orders.filter((row) => row.invoiceId);
    const ids = [...new Set(sent.map((row) => row.invoiceId))];
    check(ids.length === 7 && ids.every((id) => id.startsWith("INV2-")) && sent.every((row) => row.payerLink?.startsWith("https://www.sandbox.paypal.com/")),
      `7 real sandbox invoices with payer links (first: ${ids[0]})`);
    const otherJudge = await browser.newPage({ viewport });
    await otherJudge.goto(BASE, { waitUntil: "load" });
    await otherJudge.waitForSelector(".ag-overlay", { timeout: SLOW });
    check((await liveState(otherJudge)).orders.length === 0 && (await otherJudge.locator("#load-demo").isVisible()), "a second browser at the same moment: its own empty table, Load demo visible");
    await otherJudge.close();
    const afterSend = await allBuyers(page);
    check(afterSend.filter((text) => text.includes("Copy message") && text.includes("Open invoice")).length === 7 && !afterSend.some((text) => text.includes("Copy link")),
      "7 rows show Copy message and Open invoice, none show Copy link");
    if (viewport.name === "laptop") {
      const scanBg = await page.$eval("#pickup-scan", (el) => getComputedStyle(el).backgroundColor);
      check(scanBg === "rgb(238, 241, 250)", `after sending, Pickup scan is a pale button (${scanBg})`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await shot("2-sent", { fullPage: true });

    // The buyer's "Your order" page (6 Nov): Lina opens the link from her Copy message in a browser of her own
    // (no cookie, a phone's screen on the phone run), checks it and taps Looks right.
    const linaRow = sent.find((row) => row.buyer === "Lina");
    const linaLink = (await liveState(page)).texts.find((t) => t.buyer === "Lina").message.split(" ").at(-1);
    check(new RegExp(`^${BASE}/order#[A-Za-z0-9_-]{43}$`).test(linaLink), `Lina's Copy message sends her order page: ${linaLink.replace(/#.*/, "#...")}`);
    const buyerContext = await browser.newContext({ viewport: viewport.name === "phone" ? PHONE : viewport });
    const buyer = await buyerContext.newPage();
    buyer.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`buyer: ${msg.type()}: ${msg.text()}`));
    buyer.on("pageerror", (err) => errors.push(`buyer: ${err.message}`));
    buyer.on("response", (res) => res.status() >= 400 && errors.push(`buyer: HTTP ${res.status()} ${res.url()}`));
    buyer.on("request", (req) => !req.url().startsWith(BASE) && !req.url().startsWith("data:") && errors.push(`buyer: other site ${req.url()}`));
    await buyer.goto(linaLink, { waitUntil: "load" });
    await buyer.waitForSelector("#order-content:not([hidden])", { timeout: SLOW });
    const buyerWords = async (selector) => plain(await buyer.$eval(selector, (el) => el.innerText));
    check((await buyerWords("#order-items")) === "3 × Classic brownies (box of 6) RM 54.00" && (await buyerWords("#order-total")) === "RM 54.00"
      && (await buyerWords("#order-when")) === "Delivery, Sat 31 Oct" && (await buyerWords("#order-status")) === "Not paid",
      `her page: "${await buyerWords("#order-items")}", ${await buyerWords("#order-when")}, ${await buyerWords("#order-status")}`);
    check((await buyer.$eval("#pay-link", (el) => el.href)) === linaRow.payerLink, "its Pay button opens her real sandbox invoice");
    check((await buyer.$$("#order-messages .chat-msg")).length === 3 && !(await buyerContext.cookies()).some((c) => c.name === VISITOR_COOKIE), "her 3 messages; no visitor cookie for her");
    check(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "her page: no sideways scroll");
    await buyer.screenshot({ path: `${OUT}${viewport.width}-2-order-page.png`, fullPage: true });
    await buyer.click("#answer-ok");
    await buyer.waitForSelector("#answer-said:not([hidden])", { timeout: SLOW });
    check((await buyerWords("#answer-said")) === "You said this looks right. Thank you!", "Looks right is saved");
    await page.click("#refresh-status");
    await page.waitForTimeout(1500);
    await goToBuyerPage(page, "Lina");
    check(plain(await page.locator(ROWS, { hasText: "Lina" }).innerText()).includes("Confirmed by buyer"), "the seller's row says Confirmed by buyer after Refresh status");

    // Open on my phone: the real QR from the laptop's screen. The phone below opens exactly what it says.
    await page.click("#open-on-phone");
    await page.waitForSelector("#pair-qr", { timeout: SLOW });
    await page.waitForTimeout(500);
    const pairLink = await readQrOnScreen(page, "#pair-qr");
    check(new RegExp(`^${BASE}/pair#[A-Za-z0-9_-]{22}$`).test(pairLink ?? "") && !pairLink.includes(cookie.value), `the laptop's QR reads as a one-time https link: ${pairLink?.replace(/#.*/, "#...")}`);
    check(plain(await page.$eval("#pair-help", (el) => el.textContent)) === PAIR_HELP, "with the plain words");
    await shot("2a-pair-qr");
    await page.click("#drawer-close");

    // Pickup scan: PayPal's real QR for Aisyah's invoice, in front of a fake camera, on a phone paired with that
    // link (the camera flags belong to a whole browser, so the phone needs a browser of its own).
    const aisyah = sent.find((row) => row.buyer === "Aisyah");
    check(/, which shows your pickup QR once paid: https:\/\/\S+\/order#[A-Za-z0-9_-]{43}$/.test((await liveState(page)).texts.find((t) => t.buyer === "Aisyah").message), "Aisyah's pickup message sends her order page, which shows the QR once paid");
    const qr = await page.evaluate(async (id) => (await fetch(`/api/invoices/${id}/qr`)).json(), aisyah.invoiceId);
    check(Boolean(qr.png), `PayPal made a real QR for Aisyah's invoice ${aisyah.invoiceId}`);
    const cameraFile = join(mkdtempSync(join(tmpdir(), "chatching-live-camera-")), "qr.y4m");
    await writeCameraFile(browser, qr.png, cameraFile);
    const cameraBrowser = await chromium.launch({ channel: "chrome", headless: true, args: cameraArgs(cameraFile) });
    try {
      const context = await cameraBrowser.newContext({ viewport: PHONE });
      const scan = await context.newPage();
      scan.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`scan: ${msg.type()}: ${msg.text()}`));
      scan.on("pageerror", (err) => errors.push(`scan: ${err.message}`));
      scan.on("response", (res) => res.status() >= 400 && errors.push(`scan: HTTP ${res.status()} ${res.url()}`));
      await scan.goto(pairLink, { waitUntil: "load" });
      await scan.waitForURL(`${BASE}/`, { timeout: SLOW });
      await scan.waitForSelector(ROWS, { timeout: SLOW });
      check(scan.url() === `${BASE}/`, `the phone lands on the app, no code in the address bar: ${scan.url()}`);
      const paired = (await context.cookies()).find((c) => c.name === VISITOR_COOKIE);
      check(paired?.value === cookie.value && paired.httpOnly && paired.secure && paired.sameSite === "Lax", "the phone has the same visitor, in an HttpOnly, Secure, SameSite=Lax cookie");
      check((await liveState(scan)).orders.length === (await liveState(page)).orders.length, "the phone sees the same table");
      await scan.waitForTimeout(500);
      await scan.screenshot({ path: `${OUT}${viewport.width}-2a-phone-orders.png` });
      const usedTwice = await browser.newPage({ viewport: PHONE });
      await usedTwice.goto(pairLink, { waitUntil: "load" });
      await usedTwice.waitForFunction((words) => document.getElementById("pair-words").textContent === words, PAIR_EXPIRED, { timeout: SLOW });
      check(usedTwice.url() === `${BASE}/pair` && !(await usedTwice.context().cookies()).some((c) => c.name === VISITOR_COOKIE), `a second phone with the same link: "${PAIR_EXPIRED}", no cookie, no code in the address bar`);
      await usedTwice.screenshot({ path: `${OUT}${viewport.width}-2a-phone-expired.png` });
      await usedTwice.close();
      await scan.locator("[data-pickup-scan]:visible").first().click();
      await scan.waitForSelector("#scan-result:not([hidden])", { timeout: SLOW });
      check(plain(await scan.$eval("#scan-words", (el) => el.textContent)) === "Not paid yet: RM 54.00", `the real QR, the live status: "${plain(await scan.$eval("#scan-words", (el) => el.textContent))}"`);
      check(plain(await scan.$eval("#scan-result", (el) => el.innerText)).includes("Aisyah, 3 x Classic brownies"), "it names Aisyah and her items");
      await scan.waitForTimeout(300);
      await scan.screenshot({ path: `${OUT}${viewport.width}-2b-scan-amber.png` });
      scan.once("dialog", (dialog) => dialog.accept());
      await scan.click("#scan-cash");
      await scan.waitForSelector("#scan-collected", { timeout: SLOW });
      check(plain(await scan.$eval("#scan-words", (el) => el.textContent)) === "Paid: Aisyah, 3 x Classic brownies", `after the Record cash shortcut: "${plain(await scan.$eval("#scan-words", (el) => el.textContent))}"`);
      await scan.waitForTimeout(300);
      await scan.screenshot({ path: `${OUT}${viewport.width}-2c-scan-green.png` });
      await scan.click("#scan-collected");
      await scan.waitForSelector("#scan-result .badge-collected", { timeout: SLOW });
      await scan.evaluate(() => { window.tracksInUse = document.getElementById("scan-video").srcObject?.getTracks() ?? []; });
      await scan.click("#scan-close");
      check(await scan.evaluate(() => window.tracksInUse.length > 0 && window.tracksInUse.every((track) => track.readyState === "ended")), "the camera stops when the sheet closes");
      const row = (await liveState(scan)).orders.find((other) => other.buyer === "Aisyah");
      check(row.collected === true && row.invoiceStatus === "Paid (cash/bank)", `saved: ${row.invoiceStatus}, collected`);
      await context.close();
    } finally {
      await cameraBrowser.close();
    }
    await page.click("#refresh-status");
    await page.waitForSelector(`${ROWS} .badge-collected`, { state: "attached", timeout: SLOW }).catch(() => {});
    await page.waitForTimeout(800);
    await goToBuyerPage(page, "Aisyah");
    check((await page.locator(ROWS, { hasText: "Aisyah" }).locator(".badge-collected").count()) === 1, "Refresh status shows the phone's Collected on the laptop");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(ROWS, { timeout: SLOW });
    await page.waitForTimeout(800);
    await goToBuyerPage(page, "Aisyah");
    check((await page.locator(ROWS, { hasText: "Aisyah" }).locator(".badge-collected").count()) === 1, "and after a reload");

    // Record cash for Lina in her drawer (the QR code comes from PayPal too).
    await goToBuyerPage(page, "Lina");
    const lina = page.locator(ROWS, { hasText: "Lina" });
    await lina.locator(".chips").click();
    await page.waitForSelector("#drawer.is-open #pay-method", { timeout: SLOW });
    await page.waitForSelector("#qr-image", { timeout: SLOW }).catch(() => {});
    await page.waitForTimeout(800);
    check(await page.$eval("#qr-image", (img) => img.complete && img.naturalWidth > 0).catch(() => false), "her drawer shows PayPal's real QR code");
    const linaInvoice = sent.find((row) => row.buyer === "Lina").invoiceId;
    const [saved] = await Promise.all([page.waitForEvent("download"), page.click("#save-qr")]);
    const savedBytes = readFileSync(await saved.path());
    check(saved.suggestedFilename() === "pickup-Lina.png" && savedBytes.subarray(1, 4).toString() === "PNG", `Save QR gives ${saved.suggestedFilename()}, a real PNG of ${savedBytes.length} bytes`);
    check((await readQrOnScreen(page, "#qr-image"))?.includes(linaInvoice), "the QR holds her invoice");
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
    check(badge === "Paid (cash/bank)" && paidCard.includes("RM 108.00"), `Refresh shows Paid: "${badge}"; "${paidCard}"`); // Lina + Aisyah
    check(!reply.notice && !reply.rateLimited, `Refresh answered without a notice${reply.notice ? `: ${reply.notice}` : ""}`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("4-paid", { fullPage: true });

    // Lina comes back to her page: Paid, no Pay button, and PayPal's real QR for her invoice.
    await buyer.reload({ waitUntil: "load" });
    await buyer.waitForFunction(() => document.getElementById("order-status").textContent === "Paid", null, { timeout: SLOW });
    await buyer.waitForSelector("#order-qr-image", { timeout: SLOW }).catch(() => {});
    check(await buyer.$eval("#order-pay", (el) => el.hidden), "her page: Paid, and the Pay button is gone");
    check((await readQrOnScreen(buyer, "#order-qr-image"))?.includes(linaRow.invoiceId), "her page shows PayPal's real QR, holding her invoice");
    await buyer.screenshot({ path: `${OUT}${viewport.width}-4-order-page-paid.png`, fullPage: true });

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
    const end = await liveState(page);
    check((await cards(page)).includes("Orders 0") && end.orders.length === 0, `Reset demo: the table is empty ("${await cards(page)}")`);
    check(end.aiCallsLeft === aiBefore, `AI calls left unchanged at the end (${end.aiCallsLeft})`);
    await shot("6-reset", { fullPage: true });
    await buyer.reload({ waitUntil: "load" });
    await buyer.waitForFunction(() => document.getElementById("order-words").textContent.startsWith("This order link doesn't work any more."), null, { timeout: SLOW });
    check(await buyer.$eval("#order-content", (el) => el.hidden), "after Reset demo her link stops working");
    await buyerContext.close();

    check(errors.length === 0, `no console errors, warnings or failed requests${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(outside.size === 0, `the seller's page loaded nothing from another site${outside.size ? `: ${[...outside].join(", ")}` : ""}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: the whole flow works on the hosted app.");
process.exitCode = failed ? 1 : 0;
