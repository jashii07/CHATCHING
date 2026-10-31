// The browser check for the pickup scan (Step 10c), at laptop and phone widths. Chromium's fake camera plays
// a REAL PayPal sandbox QR image (test/fixtures/paypal-qr.png), so the camera, jsQR and the whole path run for
// real; PayPal itself is the FAKE in scripts/fake-paypal.mjs, given the id inside that QR for Lina's invoice.
//   Camera: scan -> amber "Not paid yet" -> Record cash -> green "Paid" -> Collected -> badge in the table and
//           the drawer -> Undo. The sheet is full screen, and the camera stops when it closes.
//   Stranger's QR: the words, and nothing leaves the phone. Images never leave it either.
//   Fallback: camera refused or missing -> type the number, paste the link; bad input; not in your orders.
// It fails on any console error or warning, and on any sideways scroll.
// Run: npm run ui-pickup. Screenshots go to tmp/screenshots-pickup/ (git-ignored).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { cameraArgs, writeCameraFile } from "./fake-camera.mjs";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-pickup/", import.meta.url));
const CAMERA_FILE = join(mkdtempSync(join(tmpdir(), "chatching-camera-")), "paypal-qr.y4m");
const QR_PNG = readFileSync(new URL("../test/fixtures/paypal-qr.png", import.meta.url)).toString("base64");
const QR_INVOICE = "INV2-BKCU-NGE3-RZG3-U35Y"; // what test/fixtures/paypal-qr.png holds
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const NOT_OUR_QR = "This isn't a ChatChing invoice QR.";
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const GREEN = "rgb(220, 242, 227)";
const AMBER = "rgb(252, 239, 214)";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const setup = await chromium.launch({ channel: "chrome", headless: true });
await writeCameraFile(setup, QR_PNG, CAMERA_FILE);
await setup.close();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: cameraArgs(CAMERA_FILE) });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"
const words = async (page, selector) => plain(await page.$eval(selector, (el) => el.innerText));
const background = (page, selector) => page.$eval(selector, (el) => getComputedStyle(el).backgroundColor);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const scanButton = (page) => page.locator("[data-pickup-scan]:visible").first();
const stateOf = (page) => page.evaluate(async () => (await fetch("/api/state")).json());

function watch(page, errors) {
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("requestfailed", (req) => errors.push(`failed: ${req.url()} (${req.failure()?.errorText})`));
}

async function readDemo(page) {
  await page.click("#load-demo");
  await page.waitForFunction(() => document.getElementById("read-message").textContent.includes("Demo chats loaded"));
  await page.click("#read-orders");
  await page.waitForSelector(ROWS);
  await page.waitForTimeout(300);
}

async function goToBuyerPage(page, buyer) {
  for (let i = 0; i < 3 && !(await page.locator(ROWS, { hasText: buyer }).count()); i++) {
    const next = !(await page.$eval("#page-next", (el) => el.disabled));
    await page.click(next ? "#page-next" : "#page-prev");
    await page.waitForTimeout(200);
  }
}

async function closeSheet(page) {
  await page.click("#scan-close");
  await page.waitForSelector("#scan-sheet", { state: "hidden" });
}

// Type or paste into the fallback box and wait for the answer.
async function typeIn(page, text) {
  await page.evaluate(() => { document.getElementById("scan-result").hidden = true; });
  await page.fill("#scan-input", text);
  await page.click("#scan-check");
  await page.waitForSelector("#scan-result:not([hidden])");
  await page.waitForTimeout(100);
}

// Everything on the sheet fits the screen and can be tapped.
async function sheetIsTappable(page, label) {
  const small = await page.$$eval("#scan-sheet button:not([hidden]), #scan-sheet input", (els) => els
    .filter((el) => el.offsetParent !== null)
    .filter((el) => { const box = el.getBoundingClientRect(); return box.height < 44 || box.width < 44; })
    .map((el) => el.id || el.textContent));
  check(small.length === 0, `${label}: every control is at least 44 px${small.length ? ` (too small: ${small.join(", ")})` : ""}`);
  const out = await page.$$eval("#scan-sheet *", (els) => els
    .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().right > innerWidth + 0.5)
    .map((el) => el.id || el.className || el.tagName));
  check(out.length === 0, `${label}: nothing runs off the right edge${out.length ? ` (${out.join(", ")})` : ""}`);
}

try {
  for (const viewport of WIDTHS) {
    console.log(`\n${viewport.width} px (${viewport.name})`);
    const shot = (page, step, options = {}) => page.screenshot({ path: `${OUT}${viewport.width}-${step}.png`, ...options });
    const fake = fakePayPal();
    const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
    const visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-pickup-"));
    const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir, paypal }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://localhost:${server.address().port}`;
    const errors = [];
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    watch(page, errors);
    // Remembers what the page asks the camera for. Only this check does this; the real page keeps no record.
    await page.addInitScript(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => { window.cameraAsked = constraints; return real(constraints); };
    });
    const posts = [];
    const hosts = new Set();
    page.on("request", (req) => {
      hosts.add(new URL(req.url()).host);
      if (req.method() === "POST") posts.push({ path: new URL(req.url()).pathname, body: req.postData() ?? "" });
    });

    try {
      await page.goto(base);
      await page.waitForSelector(".ag-overlay");
      await page.waitForTimeout(300);
      check(!(await page.locator("[data-pickup-scan]:visible").count()), "no Pickup scan button before any invoice exists");
      await readDemo(page);

      // Lina's invoice gets the id inside the real QR; then the page sends the other six.
      fake.useNextId(QR_INVOICE);
      await page.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyer: "Lina" }) }));
      await page.reload();
      await page.waitForSelector(ROWS);
      await page.waitForTimeout(300);
      await page.locator("[data-send-invoices]:visible").first().click();
      await page.waitForFunction(() => /\d+ of 6 sent/.test(document.getElementById("send-message").textContent));
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(200);
      check(await scanButton(page).isVisible(), "the Pickup scan button shows once invoices exist");
      await shot(page, "1-button");

      // ---- The camera, reading the real QR image ----
      await scanButton(page).click();
      await page.waitForSelector("#scan-sheet:not([hidden])");
      await page.waitForFunction(() => document.getElementById("scan-video").videoWidth > 0 || !document.getElementById("scan-result").hidden, null, { timeout: 15_000 });
      const box = await page.$eval("#scan-sheet", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      check(box.x === 0 && box.y === 0 && box.width === viewport.width && box.height === viewport.height, `the sheet is full screen: ${box.width} x ${box.height}`);
      const asked = await page.evaluate(() => window.cameraAsked);
      check(asked?.video?.facingMode?.ideal === "environment" && !asked.audio, `it asks for the back camera, no sound: ${JSON.stringify(asked)}`);
      await page.waitForSelector("#scan-result:not([hidden])", { timeout: 15_000 });
      await page.waitForTimeout(200);
      check((await words(page, "#scan-words")) === "Not paid yet: RM 54.00", `the real QR reads as: "${await words(page, "#scan-words")}"`);
      check((await words(page, "#scan-result")).includes("Lina, 3 x Classic brownies"), "it names the buyer and items");
      check((await background(page, "#scan-result")) === AMBER, "amber = check this");
      check(!(await page.locator("#scan-collected:visible").count()), "no Collected button while unpaid");
      check(await page.locator("#scan-cash").isVisible(), "the Record cash shortcut is offered");
      await sheetIsTappable(page, "amber");
      await shot(page, "2-amber");

      page.once("dialog", (dialog) => dialog.accept());
      await page.click("#scan-cash");
      await page.waitForSelector("#scan-collected", { timeout: 5000 });
      await page.waitForTimeout(200);
      check((await words(page, "#scan-words")) === "Paid: Lina, 3 x Classic brownies", `after Record cash: "${await words(page, "#scan-words")}"`);
      check((await background(page, "#scan-result")) === GREEN, "green = money arrived");
      check(fake.invoices.get(QR_INVOICE).status === "MARKED_AS_PAID", "the cash payment is recorded in PayPal");
      await sheetIsTappable(page, "green");
      await shot(page, "3-green");

      const calls = fake.calls.length;
      await page.click("#scan-collected");
      await page.waitForSelector("#scan-result .badge-collected");
      await page.waitForTimeout(150);
      check(await page.locator("#scan-undo").isVisible(), "Collected shows a badge and an Undo");
      check(fake.calls.length === calls, "Collected sends nothing to PayPal");
      await shot(page, "4-collected");

      // The camera stops when the sheet closes.
      await page.evaluate(() => { window.tracksInUse = document.getElementById("scan-video").srcObject?.getTracks() ?? []; });
      const liveBefore = await page.evaluate(() => window.tracksInUse.filter((t) => t.readyState === "live").length);
      await closeSheet(page);
      check(liveBefore === 1 && await page.evaluate(() => window.tracksInUse.every((t) => t.readyState === "ended") && !document.getElementById("scan-video").srcObject), `the camera stops when the sheet closes (${liveBefore} track live before, none after)`);

      // ---- The badge in the table, the CSV and the drawer; Undo ----
      await goToBuyerPage(page, "Lina");
      const lina = page.locator(ROWS, { hasText: "Lina" });
      check((await lina.locator(".badge-collected").count()) === 1 && (await lina.locator(".badge").first().innerText()).includes("Paid"), "the table shows Paid and a Collected badge");
      check((await page.evaluate(() => grid.getDataAsCsv({ columnKeys: ["buyer", "status"], exportedRows: "all" }))).includes("Paid (cash/bank), collected"), "the CSV says collected too");
      const tag = await lina.locator(".badge-collected").evaluate((el) => {
        const box = el.getBoundingClientRect();
        const cell = el.closest(".ag-cell").getBoundingClientRect();
        return box.right <= cell.right + 0.5 && box.bottom <= cell.bottom + 0.5;
      });
      check(tag, "the Collected badge stays inside its cell");
      await lina.screenshot({ path: `${OUT}${viewport.width}-5-row.png` });
      await page.evaluate(() => scrollTo(0, 0)); // a full-page shot of a scrolled page draws the sticky bars mid-page
      await shot(page, "5-table", { fullPage: true });
      await page.reload();
      await page.waitForSelector(ROWS);
      await page.waitForTimeout(300);
      await goToBuyerPage(page, "Lina");
      check((await lina.locator(".badge-collected").count()) === 1, "the badge survives a reload");
      await lina.locator(".chips").click();
      await page.waitForSelector("#drawer.is-open #undo-collected");
      await page.waitForTimeout(300);
      check((await page.locator("#drawer .badge-collected").count()) >= 1, "the drawer shows the Collected badge");
      check((await words(page, "#drawer .qr-card")).includes("Invoice number: CHATCHING-") || !(await page.locator("#drawer .qr-card").count()), "the drawer names the invoice number to type");
      await shot(page, "6-drawer");
      await page.click("#undo-collected");
      await page.waitForSelector("#drawer.is-open #undo-collected", { state: "detached" });
      check(!(await page.locator("#drawer .badge-collected").count()), "Undo in the drawer takes the badge away");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      check((await lina.locator(".badge-collected").count()) === 0, "and from the table; the invoice stays paid");

      // ---- A second scan: Collected, Undo in the sheet, Scan next, Escape ----
      await scanButton(page).click();
      await page.waitForSelector("#scan-collected", { timeout: 15_000 });
      await page.click("#scan-collected");
      await page.waitForSelector("#scan-undo");
      await page.click("#scan-next");
      await page.waitForSelector("#scan-result", { state: "hidden" });
      await page.waitForSelector("#scan-undo", { timeout: 15_000 });
      check((await words(page, "#scan-result")).includes("Collected"), "scanning a collected invoice again says so, so it is not handed over twice");
      await page.click("#scan-undo");
      await page.waitForSelector("#scan-collected");
      check(!(await page.locator("#scan-result .badge-collected").count()), "Undo in the sheet works too");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#scan-sheet", { state: "hidden" });
      check(await page.evaluate(() => !document.getElementById("scan-video").srcObject), "Escape closes the sheet and stops the camera");

      // ---- A stranger's QR: the words, and it never leaves the phone ----
      await page.evaluate(() => { window.realJsQR = window.jsQR; window.jsQR = () => ({ data: "https://example.com/menu" }); });
      posts.length = 0;
      await scanButton(page).click();
      await page.waitForFunction((text) => document.getElementById("scan-hint").textContent === text, NOT_OUR_QR, { timeout: 15_000 });
      check(await page.locator("#scan-video").isVisible(), `a stranger's QR: "${NOT_OUR_QR}" and the camera keeps scanning`);
      check(!posts.some((post) => post.path.startsWith("/api/pickup")), "a stranger's QR is never sent to the server");
      await sheetIsTappable(page, "camera");
      await shot(page, "2b-camera"); // the only moment the camera view stays on screen: a real QR is read at once
      await page.evaluate(() => { window.jsQR = window.realJsQR; });
      await page.waitForSelector("#scan-result:not([hidden])", { timeout: 15_000 });
      await closeSheet(page);

      // ---- Images never leave the phone; no new website is contacted ----
      check(posts.every((post) => post.body.length < 500), "nothing the size of an image was ever posted");
      check([...hosts].every((host) => host.startsWith("localhost") || host === "cdn.jsdelivr.net"), `only our server and the existing CDN: ${[...hosts].join(", ")}`);
      check(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => new URL(entry.name).pathname === "/vendor/jsQR.js")), "jsQR came from our own server");

      // ---- The camera refused: type or paste ----
      const rows = (await stateOf(page)).orders;
      const row = (buyer) => rows.find((other) => other.buyer === buyer);
      const refused = await context.newPage();
      watch(refused, errors);
      await refused.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      });
      await refused.goto(base);
      await refused.waitForSelector(ROWS);
      await refused.waitForTimeout(300);
      await scanButton(refused).click();
      await refused.waitForFunction(() => document.getElementById("scan-hint").textContent.includes("refused"));
      await refused.waitForTimeout(150);
      check(!(await refused.locator("#scan-video").isVisible()), "camera refused: no camera box");
      check(await refused.evaluate(() => document.activeElement.id === "scan-input"), `the box takes over: "${await words(refused, "#scan-hint")}"`);
      await sheetIsTappable(refused, "fallback");
      await shot(refused, "7-fallback");

      await typeIn(refused, "hello");
      check((await words(refused, "#scan-words")) === NOT_OUR_QR, `bad input: "${await words(refused, "#scan-words")}"`);
      check((await background(refused, "#scan-result")) === AMBER, "in amber");
      await typeIn(refused, row("Arif").invoiceNumber.toLowerCase());
      check((await words(refused, "#scan-words")) === "Not paid yet: RM 24.00", `the typed invoice number: "${await words(refused, "#scan-words")}"`);
      await shot(refused, "8-typed");
      await typeIn(refused, row("Arif").invoiceId);
      check((await words(refused, "#scan-result")).includes("Arif, 2 x Kuih bahulu"), "the typed invoice id");
      fake.pay(row("Aisyah").invoiceId);
      await refused.waitForTimeout(10_500); // a status stays cached for 10 s, so a real wait for a real answer
      await typeIn(refused, row("Aisyah").payerLink);
      check((await words(refused, "#scan-words")) === "Paid: Aisyah, 3 x Classic brownies", `the pasted payer link: "${await words(refused, "#scan-words")}"`);
      await refused.click("#scan-collected");
      await refused.waitForSelector("#scan-result .badge-collected");
      check(await refused.locator("#scan-undo").isVisible(), "Collected works without a camera");
      await typeIn(refused, "INV2-AAAA-BBBB-CCCC-DDDD");
      check((await words(refused, "#scan-words")) === "Not in your orders.", `an invoice that isn't here: "${await words(refused, "#scan-words")}"`);
      await sheetIsTappable(refused, "not in your orders");
      await shot(refused, "9-not-yours");
      await refused.close();

      // ---- No camera at all (or a page that isn't secure): the same box ----
      const missing = await context.newPage();
      watch(missing, errors);
      await missing.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined }));
      await missing.goto(base);
      await missing.waitForSelector(ROWS);
      await missing.waitForTimeout(300);
      await scanButton(missing).click();
      await missing.waitForFunction(() => document.getElementById("scan-hint").textContent.includes("No camera"));
      check(await missing.locator("#scan-input").isVisible(), `no camera: "${await words(missing, "#scan-hint")}"`);
      await missing.close();

      // ---- The camera never stays on behind the seller's back ----
      const late = await context.newPage();
      watch(late, errors);
      await late.addInitScript(() => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          await new Promise((resolve) => setTimeout(resolve, 600)); // the seller reads the permission question
          window.lastStream = await real(constraints);
          return window.lastStream;
        };
      });
      const liveTracks = (target) => target.evaluate(() => window.lastStream.getTracks().filter((track) => track.readyState === "live").length);
      const setVisibility = (target, state) => target.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { value, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
      await late.goto(base);
      await late.waitForSelector(ROWS);
      await late.waitForTimeout(300);
      await scanButton(late).click();
      await late.click("#scan-close");
      await late.waitForFunction(() => window.lastStream, null, { timeout: 5000 });
      await late.waitForTimeout(200);
      check((await liveTracks(late)) === 0, "closed while the camera question was up: the camera stays off");

      await scanButton(late).click();
      await late.waitForSelector("#scan-result:not([hidden])", { timeout: 15_000 });
      check((await liveTracks(late)) === 1, "the camera is on while the sheet is open");
      await setVisibility(late, "hidden");
      check((await liveTracks(late)) === 0, "the phone is put away: the camera stops");
      await setVisibility(late, "visible");
      await late.waitForTimeout(800);
      check((await liveTracks(late)) === 0, "back with an answer on screen: the camera stays off until it is wanted");
      await late.click("#scan-next");
      await late.waitForFunction(() => window.lastStream.getTracks().some((track) => track.readyState === "live"), null, { timeout: 5000 });
      check(true, "Scan next turns it on again");
      await closeSheet(late);
      await late.close();

      check(await noSideScroll(page), "no sideways scroll");
      check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    } finally {
      await context.close();
      server.closeAllConnections();
      server.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: the pickup scan works, with the camera and without it.");
process.exitCode = failed ? 1 : 0;
