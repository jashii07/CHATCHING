// The browser check for "Open on my phone" and the buyer's pickup QR, with two browsers at once: a laptop
// (1280 px) and a phone (390 px), each its own context, so its own cookies, like two real devices.
//   Pair: laptop QR -> phone opens the link -> same table -> phone scans -> Collected shows on the laptop.
//   Refused: used twice, wrong code, no code, 10 minutes later. The code stays out of the address bar and the server.
//   Also: a new link for a second phone, a phone that stays open while the laptop sends, Pickup scan reading
//   the pairing QR, Save QR, and the "Show this QR" line.
// Chromium's fake camera plays a REAL PayPal QR (test/fixtures/paypal-qr.png); PayPal is scripts/fake-paypal.mjs.
// It fails on any console error or warning, and on any sideways scroll.
// Run: npm run ui-pair. Screenshots go to tmp/screenshots-pair/ (git-ignored).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { VISITOR_COOKIE } from "../src/visitors.js";
import { cameraArgs, readQrOnScreen, writeCameraFile } from "./fake-camera.mjs";
import { fakePayPal, QR_PNG as FAKE_QR_PNG } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-pair/", import.meta.url));
const CAMERA_FILE = join(mkdtempSync(join(tmpdir(), "chatching-pair-camera-")), "paypal-qr.y4m");
const REAL_QR = readFileSync(new URL("../test/fixtures/paypal-qr.png", import.meta.url)).toString("base64");
const QR_INVOICE = "INV2-BKCU-NGE3-RZG3-U35Y"; // what test/fixtures/paypal-qr.png holds
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const LAPTOP = { width: 1280, height: 800 };
const IPAD = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const HELP = "Scan this with your phone to open the same orders. Works once, for 10 minutes.";
const EXPIRED = "This link has expired. Make a new one on your laptop.";
const TEN_MINUTES = 10 * 60_000;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const setup = await chromium.launch({ channel: "chrome", headless: true });
await writeCameraFile(setup, REAL_QR, CAMERA_FILE);
await setup.close();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: cameraArgs(CAMERA_FILE) });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim();
const words = async (page, selector) => plain(await page.$eval(selector, (el) => el.innerText));
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const stateOf = (page) => page.evaluate(async () => (await fetch("/api/state")).json());
const shot = (page, name, options = {}) => page.screenshot({ path: `${OUT}${name}.png`, ...options });
const scanButton = (page) => page.locator("[data-pickup-scan]:visible").first();
const cookieOf = async (page) => (await page.context().cookies()).find((c) => c.name === VISITOR_COOKIE);

const fake = fakePayPal();
const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
let later = 0; // moves the server's clock, so the 10 minutes don't take 10 minutes
const server = createApp(loadConfig(FAKE_KEYS), {
  log: () => {}, visitorsDir: mkdtempSync(join(tmpdir(), "chatching-ui-pair-")), paypal, now: () => Date.now() + later,
}).listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
const LINK = new RegExp(`^${base}/pair#([A-Za-z0-9_-]{22})$`);
const seenByServer = []; // every address that reached the server, exactly as it arrived
server.on("request", (req) => seenByServer.push(req.url));

const errors = [];
const contexts = [];
async function device(viewport, name) {
  const context = await browser.newContext({ viewport, ...(viewport === PHONE && { isMobile: true, hasTouch: true }), acceptDownloads: true });
  contexts.push(context);
  const page = await context.newPage();
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${name}: ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(`${name}: ${err.message}`));
  page.on("requestfailed", (req) => !req.url().includes("/pair") && errors.push(`${name}: failed: ${req.url()} (${req.failure()?.errorText})`));
  return page;
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

async function openBuyer(page, buyer) {
  await goToBuyerPage(page, buyer);
  await page.locator(ROWS, { hasText: buyer }).locator(".chips").click();
  await page.waitForSelector("#drawer.is-open #qr-image");
  await page.waitForTimeout(350);
}

async function closeDrawer(page) {
  await page.click("#drawer-close");
  await page.waitForSelector("#drawer", { state: "hidden" });
}

// The drawer's QR: what a phone would read from it.
async function newLink(page) {
  if (await page.locator("#drawer.is-open").count()) {
    await page.click("#pair-new");
  } else await page.click("#open-on-phone");
  await page.waitForSelector("#pair-qr");
  await page.waitForTimeout(350);
  return readQrOnScreen(page, "#pair-qr");
}

// Every control fits the screen, at least 44 px.
async function tappable(page, selector, label) {
  const small = await page.$$eval(selector, (els) => els
    .filter((el) => el.offsetParent !== null)
    .filter((el) => { const box = el.getBoundingClientRect(); return box.height < 44 || box.width < 44 || box.right > innerWidth + 0.5; })
    .map((el) => el.id || el.textContent));
  check(small.length === 0, `${label}: at least 44 px and on screen${small.length ? ` (${small.join(", ")})` : ""}`);
}

async function opensLink(page, link) {
  await page.goto(link);
  await page.waitForURL(`${base}/`);
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);
}

// A link that doesn't work: the plain words, a way back, and an address bar with no code in it.
async function refused(page, link, label) {
  await page.goto(link);
  await page.waitForFunction((text) => document.getElementById("pair-words").textContent === text, EXPIRED);
  check((await words(page, "#pair-words")) === EXPIRED, `${label}: "${EXPIRED}"`);
  check(page.url() === `${base}/pair`, `${label}: the address bar shows ${page.url().replace(base, "")}`);
  check(await page.locator("#pair-home").isVisible(), `${label}: a way back to the app`);
}

try {
  // ---- The laptop: orders read and invoices sent ----
  console.log("\nLaptop");
  const laptop = await device(LAPTOP, "laptop");
  await laptop.goto(base);
  await laptop.waitForSelector(".ag-overlay");
  await laptop.waitForTimeout(300);
  check(await laptop.locator("#open-on-phone").isVisible(), "the Open on my phone button is there before any order");
  await readDemo(laptop);
  fake.useNextId(QR_INVOICE); // Lina's invoice gets the id inside the real QR
  await laptop.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyer: "Lina" }) }));
  await laptop.reload();
  await laptop.waitForSelector(ROWS);
  await laptop.waitForTimeout(300);
  await laptop.locator("[data-send-invoices]:visible").first().click();
  await laptop.waitForFunction(() => /\d+ of 6 sent/.test(document.getElementById("send-message").textContent));
  await laptop.evaluate(() => scrollTo(0, 0));
  await laptop.waitForTimeout(200);
  await shot(laptop, "1-laptop-orders");

  // ---- The buyer's QR: Save QR and the message ----
  console.log("\nThe buyer's pickup QR");
  await openBuyer(laptop, "Lina");
  const [download] = await Promise.all([laptop.waitForEvent("download"), laptop.click("#save-qr")]);
  check(download.suggestedFilename() === "pickup-Lina.png", `Save QR: the file is ${download.suggestedFilename()}`);
  check(readFileSync(await download.path()).equals(Buffer.from(FAKE_QR_PNG, "base64")), "the file is PayPal's QR picture, byte for byte");
  check(!(await words(laptop, "#text-message")).includes("QR"), "a delivery order's message doesn't mention the QR");
  await laptop.locator("#save-qr").scrollIntoViewIfNeeded();
  await shot(laptop, "2-save-qr");
  await closeDrawer(laptop);
  await openBuyer(laptop, "Aisyah");
  check((await words(laptop, "#text-message")).endsWith("Show this QR when you pick up. Thank you!"), `a pickup order's message: "${(await words(laptop, "#text-message")).slice(-60)}"`);
  await closeDrawer(laptop);

  // ---- Pair: the QR on the laptop ----
  console.log("\nPairing: laptop + phone");
  const link = await newLink(laptop);
  const { value: visitorId } = await cookieOf(laptop);
  check(LINK.test(link ?? ""), `the laptop's QR reads as a pairing link: ${link?.replace(/#.*/, "#...")}`);
  check(!link.includes(visitorId), "the visitor id is not in the link");
  check((await words(laptop, "#pair-help")) === HELP, `the words: "${HELP}"`);
  await tappable(laptop, "#drawer button", "laptop drawer");
  await shot(laptop, "3-laptop-qr");
  const { y } = await laptop.$eval("#pair-qr", (img) => img.getBoundingClientRect());
  check(y >= 0, "the QR is in view");

  // ---- The phone opens it, as if from its camera app ----
  const phone = await device(PHONE, "phone");
  await opensLink(phone, link);
  await phone.waitForSelector(ROWS);
  await phone.waitForTimeout(300);
  check(phone.url() === `${base}/`, `the phone lands on the app; the address bar: ${phone.url()}`);
  const cookie = await cookieOf(phone);
  check(cookie?.value === visitorId, "the phone has the laptop's visitor");
  check(cookie?.httpOnly && cookie.sameSite === "Lax", "in an HttpOnly, SameSite=Lax cookie");
  const onPhone = await stateOf(phone);
  const onLaptop = await stateOf(laptop);
  check(JSON.stringify(onPhone.orders) === JSON.stringify(onLaptop.orders) && onPhone.orders.length === 12, `the same table: ${onPhone.orders.length} rows`);
  check(await noSideScroll(phone), "no sideways scroll on the phone");
  await shot(phone, "4-phone-orders");

  // ---- The phone scans the buyer's real QR ----
  await scanButton(phone).click();
  await phone.waitForSelector("#scan-result:not([hidden])", { timeout: 15_000 });
  await phone.waitForTimeout(200);
  check((await words(phone, "#scan-words")) === "Not paid yet: RM 54.00", `the phone scans a real QR: "${await words(phone, "#scan-words")}"`);
  phone.once("dialog", (dialog) => dialog.accept());
  await phone.click("#scan-cash");
  await phone.waitForSelector("#scan-collected", { timeout: 5000 });
  await phone.click("#scan-collected");
  await phone.waitForSelector("#scan-result .badge-collected");
  await phone.waitForTimeout(200);
  await shot(phone, "5-phone-collected");
  await phone.click("#scan-close");

  // ---- Collected on the laptop: Refresh status, then a reload ----
  await closeDrawer(laptop);
  await goToBuyerPage(laptop, "Lina");
  const lina = laptop.locator(ROWS, { hasText: "Lina" });
  check((await lina.locator(".badge-collected").count()) === 0, "the laptop doesn't know yet");
  await laptop.click("#refresh-status");
  await laptop.waitForSelector(`${ROWS} .badge-collected`);
  check((await lina.locator(".badge-collected").count()) === 1, "Refresh status shows Collected on the laptop, no reload needed");
  await laptop.waitForTimeout(300);
  await laptop.evaluate(() => scrollTo(0, 0));
  await shot(laptop, "6-laptop-collected", { fullPage: true });
  await laptop.reload();
  await laptop.waitForSelector(ROWS);
  await laptop.waitForTimeout(300);
  await goToBuyerPage(laptop, "Lina");
  check((await laptop.locator(ROWS, { hasText: "Lina" }).locator(".badge-collected").count()) === 1, "and after a reload too");

  // ---- Refused links ----
  console.log("\nLinks that don't work");
  const secondPhone = await device(PHONE, "second phone");
  await refused(secondPhone, link, "used already, on a second phone");
  await tappable(secondPhone, "#pair-home", "the way back");
  check(await noSideScroll(secondPhone), "no sideways scroll");
  await shot(secondPhone, "7-phone-expired");
  check((await cookieOf(secondPhone)) === undefined, "the second phone got no cookie from it");
  await refused(secondPhone, `${base}/pair#${"A".repeat(22)}`, "a wrong code");
  await refused(secondPhone, `${base}/pair#nope`, "a mangled code");
  await refused(secondPhone, `${base}/pair`, "no code at all");
  await secondPhone.click("#pair-home");
  await secondPhone.waitForSelector("#load-demo");
  await secondPhone.waitForTimeout(300);
  check((await stateOf(secondPhone)).orders.length === 0, "the way back opens this phone's own empty table");

  // A new link: the old QR dies with it, and this phone gets in.
  const second = await newLink(laptop);
  const third = await newLink(laptop);
  check(LINK.test(third) && second !== third, "Make a new link gives a different QR");
  await refused(secondPhone, second, "the QR that a newer one replaced");
  await opensLink(secondPhone, third);
  check((await cookieOf(secondPhone))?.value === visitorId, "a second phone, with its own new link, reaches the same table");

  // 10 minutes later: the server refuses it, and an open drawer says so by itself.
  const late = await device(LAPTOP, "late laptop");
  await late.context().addCookies([{ name: VISITOR_COOKIE, value: visitorId, url: base }]);
  await late.clock.install();
  await late.goto(base);
  await late.waitForSelector(ROWS);
  await late.waitForTimeout(300);
  const stale = await newLink(late);
  await late.clock.fastForward(TEN_MINUTES);
  await late.waitForSelector("#pair-note");
  check((await words(late, "#pair-note")) === EXPIRED, `after 10 minutes the drawer says: "${await words(late, "#pair-note")}"`);
  check(!(await late.locator("#pair-qr").count()), "and the old QR is gone from the screen");
  await shot(late, "8-laptop-expired");
  later = TEN_MINUTES;
  const thirdPhone = await device(PHONE, "third phone");
  await refused(thirdPhone, stale, "10 minutes old");
  later = 0;
  await late.click("#pair-new");
  await late.waitForSelector("#pair-qr");
  check(await late.locator("#pair-qr").isVisible(), "Make a new link brings a working QR back");
  await late.close();

  // ---- A phone that stays open while the laptop changes the table ----
  console.log("\nA phone left open");
  const seller = await device(LAPTOP, "seller's laptop");
  await seller.goto(base);
  await seller.waitForSelector(".ag-overlay");
  await seller.waitForTimeout(300);
  await readDemo(seller); // read BEFORE pairing: sending stays in this batch, so a new batch id can't give it away
  const stayOpen = await device(PHONE, "phone left open");
  await opensLink(stayOpen, await newLink(seller));
  await stayOpen.waitForSelector(ROWS);
  await stayOpen.waitForTimeout(300);
  check(!(await scanButton(stayOpen).count()), "paired before any invoice: no Pickup scan yet");
  await closeDrawer(seller);
  await seller.locator("[data-send-invoices]:visible").first().click();
  await seller.waitForFunction(() => /\d+ of 7 sent/.test(document.getElementById("send-message").textContent));
  await stayOpen.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // the phone is picked up again
  await stayOpen.waitForSelector("[data-pickup-scan]:visible");
  await stayOpen.waitForTimeout(200);
  check((await stateOf(stayOpen)).orders.length === 12 && (await stayOpen.locator(ROWS).count()) > 0, "coming back shows the laptop's orders and the Pickup scan button");

  // ---- Pickup scan knows the pairing QR too ----
  console.log("\nPickup scan reads the pairing QR");
  const scanning = await device(PHONE, "scanning phone");
  await scanning.goto(base);
  await scanning.waitForSelector(".ag-overlay");
  await scanning.waitForTimeout(300);
  await readDemo(scanning);
  await scanning.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyer: "Arif" }) }));
  await scanning.reload();
  await scanning.waitForSelector(ROWS);
  await scanning.waitForTimeout(300);
  const ownId = (await cookieOf(scanning)).value;
  check(ownId !== visitorId, "this phone starts with its own table");
  await scanning.addScriptTag({ url: "/vendor/jsQR.js" }); // so the page's scanner uses the stand-in below
  await scanning.evaluate(() => { window.jsQR = () => ({ data: "https://evil.example/pair#AAAAAAAAAAAAAAAAAAAAAA" }); });
  await scanButton(scanning).click();
  await scanning.waitForFunction(() => document.getElementById("scan-hint").textContent === "This isn't a ChatChing invoice QR.", null, { timeout: 15_000 });
  check(scanning.url() === `${base}/`, "a pairing link on another site is refused, and the phone stays here");
  const viaScan = await newLink(seller);
  await scanning.evaluate((text) => { window.jsQR = () => ({ data: text }); }, viaScan);
  await scanning.waitForRequest((req) => req.url() === `${base}/`, { timeout: 15_000 });
  await scanning.waitForLoadState("load");
  await scanning.waitForTimeout(800);
  check((await cookieOf(scanning))?.value === (await cookieOf(seller)).value, "scanned in Pickup scan: the phone opens the same table");
  check(!(await scanning.locator("#scan-sheet:not([hidden])").count()), "the camera sheet is gone");

  // The same, pasted into the typing box.
  const pasting = await device(PHONE, "pasting phone");
  await pasting.goto(base);
  await pasting.waitForSelector(".ag-overlay");
  await pasting.waitForTimeout(300);
  await readDemo(pasting);
  await pasting.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyer: "Arif" }) }));
  await pasting.reload();
  await pasting.waitForSelector(ROWS);
  await pasting.waitForTimeout(300);
  await scanButton(pasting).click();
  await pasting.fill("#scan-input", await newLink(seller));
  await pasting.click("#scan-check");
  await pasting.waitForURL(`${base}/`);
  await pasting.waitForTimeout(800);
  check((await cookieOf(pasting))?.value === (await cookieOf(seller)).value, "pasted into the typing box: the same");
  await closeDrawer(seller);

  // ---- The drawer at every width ----
  console.log("\nWidths");
  for (const [viewport, name] of [[IPAD, "820"], [PHONE, "390"]]) {
    const page = await device(viewport, name);
    await page.context().addCookies([{ name: VISITOR_COOKIE, value: visitorId, url: base }]);
    await page.goto(base);
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(300);
    await tappable(page, "#open-on-phone", `${name} px, the button`);
    check(await noSideScroll(page), `${name} px: no sideways scroll`);
    await page.evaluate(() => scrollTo(0, document.getElementById("open-on-phone").getBoundingClientRect().top + scrollY - 200));
    await page.waitForTimeout(200);
    await shot(page, `9-${name}-tools`);
    const read = await newLink(page);
    check(LINK.test(read ?? ""), `${name} px: the QR reads`);
    const box = await page.$eval("#pair-qr", (img) => { const r = img.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
    check(box.left >= 0 && box.right <= viewport.width && box.width >= 180, `${name} px: the QR fits, ${Math.round(box.width)} px wide`);
    await tappable(page, "#drawer button", `${name} px, the drawer`);
    await shot(page, `10-${name}-qr`);
    await closeDrawer(page);
    await openBuyer(page, "Arif");
    const [file] = await Promise.all([page.waitForEvent("download"), page.click("#save-qr")]);
    check(file.suggestedFilename() === "pickup-Arif.png", `${name} px: Save QR gives ${file.suggestedFilename()}`);
    await page.locator("#save-qr").scrollIntoViewIfNeeded();
    await tappable(page, "#save-qr", `${name} px, Save QR`);
    await shot(page, `11-${name}-save-qr`);
  }

  // ---- The code never reached the server in an address ----
  console.log("\nLeaks");
  const codes = [link, second, third, stale, viaScan].map((text) => text.split("#")[1]);
  check(!seenByServer.some((url) => codes.some((code) => url.includes(code))), `no address the server saw holds a code (${seenByServer.length} requests)`);
  check(!seenByServer.some((url) => url.includes(visitorId)), "or the visitor id");
  check(seenByServer.includes("/pair"), "the phone's page was asked for as plain /pair");

  check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: one table on two devices, and the buyer's QR, work.");
process.exitCode = failed ? 1 : 0;
