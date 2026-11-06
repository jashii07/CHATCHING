// The browser check for the user-test fixes of 6 Nov (my friend: "didn't know what to do in which order, didn't
// know to send the buyer their message, wanted a button to confirm drawer changes"), at 1280x800 and 390x844:
//   The guide: one line under the steps always says the next action (public/next-step.js): try the demo -> fix the
//     amber rows -> send invoices -> send each buyer their message -> watch for Paid -> pickup; Show me scrolls to
//     the right button and lights it up once; the steps can be tapped to scroll to their part of the page.
//   The banner right after sending: send each buyer their message (gone once every buyer has it, or on Got it).
//   The drawer: "Saved" after every change, and a Done button at the bottom that closes it.
// PayPal is the FAKE in scripts/fake-paypal.mjs: no network, no real invoices. Fails on any console error or
// warning, and on any request to another site. Run: npm run ui-guide. Screenshots go to tmp/screenshots-guide/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { NEXT_TEXT } from "../public/next-step.js";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-guide/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const BANNER = "Invoices sent. Now send each buyer their message. Tap Copy message on each row and paste it into your chat with that buyer. It has their order page, Pay button and QR code. Got it";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim();

async function startServer() {
  const visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-guide-"));
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  let skew = 0; // moves the server's clock past its 10-second status cache
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir, paypal, now: () => Date.now() + skew }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, fake, skip: (ms) => (skew += ms) };
}

const nextLine = async (page) => plain(await page.$eval("#next-text", (el) => el.textContent));
const nextShown = (page) => page.$eval("#next-step", (el) => !el.hidden && el.getBoundingClientRect().height > 0);
const bannerText = (page) => page.$eval("#sent-banner", (el) => (el.hidden ? "" : el.innerText.replace(/\s+/g, " ").trim()));
const waitForLine = (page, text) => page.waitForFunction((want) => document.getElementById("next-text")?.textContent === want, text, { timeout: 5000 }).catch(() => {});

// Click Show me, let the smooth scroll finish, and say what got focus and whether it is on screen and lit up.
async function showMe(page) {
  await page.click("#next-show");
  await page.waitForTimeout(900);
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el.getBoundingClientRect();
    const bar = document.getElementById("phone-total");
    // The phone's sticky bar covers the bottom of the screen, except for the buttons inside it.
    const bottom = getComputedStyle(bar).position === "fixed" && !bar.contains(el) ? bar.getBoundingClientRect().top : innerHeight;
    return {
      id: el.id, buyer: el.dataset?.buyer ?? null, kind: el.dataset?.kind ?? null, text: el.textContent.replace(/\s+/g, " ").trim(),
      clear: box.height > 0 && box.top >= document.querySelector(".topbar").getBoundingClientRect().bottom - 1 && box.bottom <= bottom + 1,
      pointed: el.classList.contains("is-pointed"),
    };
  });
}

// Every page of the table: run fn on each, then go back to page 1.
async function eachPage(page, fn) {
  for (let i = 0; i < 4; i++) {
    await fn();
    if (await page.$eval("#pager", (el) => el.hidden) || await page.$eval("#page-next", (el) => el.disabled)) break;
    await page.click("#page-next");
    await page.waitForTimeout(300);
  }
  while (!(await page.$eval("#pager", (el) => el.hidden)) && !(await page.$eval("#page-prev", (el) => el.disabled))) {
    await page.click("#page-prev");
    await page.waitForTimeout(200);
  }
}

async function copyAll(page, kind) {
  let copied = 0;
  await eachPage(page, async () => {
    for (const button of await page.locator(`${ROWS} .copy-text[data-kind="${kind}"]`).all()) {
      await button.click();
      copied++;
      await page.waitForTimeout(80);
    }
  });
  return copied;
}

try {
  for (const viewport of WIDTHS) {
    const { server, fake, skip } = await startServer();
    const base = `http://localhost:${server.address().port}`;
    const page = await browser.newPage({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
    const errors = [];
    const outside = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("request", (req) => !/^(data|blob):/.test(req.url()) && new URL(req.url()).origin !== base && outside.push(req.url()));
    const shot = (name, full = false) => page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-${name}.png`, fullPage: full });
    const SEND = viewport.name === "phone" ? ".phone-total [data-send-invoices]" : "#send-invoices";

    console.log(`\n${viewport.width} px (${viewport.name})`);
    await page.goto(base);
    await page.waitForSelector(".ag-overlay");
    await page.waitForTimeout(400);

    // ---- (a) An empty table: the next-step card is the first-minute starter card, on the first screen ----
    await waitForLine(page, NEXT_TEXT.start);
    const first = await page.$eval("#next-step", (el) => {
      const box = el.getBoundingClientRect();
      return { inFirstScreen: box.bottom <= innerHeight, order: box.top >= document.querySelector(".steps").getBoundingClientRect().bottom && box.bottom <= document.querySelector(".summary").getBoundingClientRect().top };
    });
    check((await nextLine(page)) === NEXT_TEXT.start && first.inFirstScreen && first.order, `(a) "${await nextLine(page)}", on the first screen between the steps and the cards (${JSON.stringify(first)})`);
    check(await page.isVisible("#try-demo") && !(await page.isVisible("#next-show")), "an empty table offers Try the demo (no Show me)");
    await shot("1-first-screen");

    // ---- The steps can be tapped: each scrolls to its part of the page ----
    const steps = await page.$$eval(".steps button", (els) => els.map((el) => ({ text: el.innerText.replace(/\s+/g, " ").trim(), tall: el.getBoundingClientRect().height >= 44 })));
    check(steps.length === 3 && steps.every((s) => s.tall), `3 step buttons, each at least 44 px tall (${JSON.stringify(steps)})`);
    for (const [n, selector, label] of [[2, ".panel.orders", "the orders"], [3, ".table-tools", "the table's buttons"], [1, "#chats", "the chat box"]]) {
      await page.click(`.steps li[data-step="${n}"] button`);
      await page.waitForTimeout(900);
      const near = await page.$eval(selector, (el) => {
        const box = el.getBoundingClientRect();
        return box.top >= document.querySelector(".topbar").getBoundingClientRect().bottom - 1 && box.top < innerHeight / 2;
      });
      check(near, `tapping step ${n} scrolls to ${label}`);
    }
    await page.evaluate(() => scrollTo(0, 0));

    // ---- Read the demo -> (b) fix the amber rows; Show me goes to the first amber buyer's Copy question ----
    await page.click("#try-demo");
    await page.waitForFunction(() => document.getElementById("chat").value.length > 100);
    await page.click("#read-orders");
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(500);
    await waitForLine(page, NEXT_TEXT.fix);
    check((await nextLine(page)) === NEXT_TEXT.fix && await nextShown(page), `(b) after reading: "${await nextLine(page)}"`);
    check(!(await page.isVisible("#try-demo")) && await page.isVisible("#next-show"), "Try the demo makes way for Show me");
    const current = plain(await page.$eval(".steps li.current", (el) => el.innerText));
    check(current.endsWith("Review orders"), `the current step is still marked: "${current}"`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("2-guide-fix");
    const fix = await showMe(page);
    check(fix.kind === "question" && fix.buyer === "priya" && fix.clear && fix.pointed, `Show me: Priya's Copy question, on screen, lit up once (${JSON.stringify(fix)})`);
    await shot("3-show-me-fix");

    // Asking both amber buyers moves the line on: (c) send the invoices.
    check((await copyAll(page, "question")) === 2, "Copy question for Priya and Jun Wei");
    await waitForLine(page, NEXT_TEXT.send);
    check((await nextLine(page)) === NEXT_TEXT.send, `(c) both asked: "${await nextLine(page)}"`);
    const send = await showMe(page);
    check(send.text.startsWith("Send 7 invoices") && send.clear && send.pointed, `Show me: the Send button (${JSON.stringify(send)})`);
    await shot("4-show-me-send");

    // ---- The drawer: "Saved" after every change, and Done closes it ----
    await page.evaluate(() => scrollTo(0, 0));
    const lina = page.locator(ROWS, { hasText: "Lina" });
    await lina.locator(".chips").click();
    await page.waitForSelector("#drawer.is-open");
    await page.waitForTimeout(400);
    const doneAtBottom = await page.$eval("#drawer-done", (el) => {
      const box = el.getBoundingClientRect();
      const drawer = document.getElementById("drawer");
      return { text: el.textContent.trim(), onScreen: box.top >= 0 && box.bottom <= innerHeight, nearBottom: innerHeight - box.bottom < 60, scrolls: drawer.scrollHeight > drawer.clientHeight };
    });
    check(doneAtBottom.text === "Done" && doneAtBottom.onScreen && doneAtBottom.nearBottom, `a Done button at the bottom of the drawer, in view without scrolling (${JSON.stringify(doneAtBottom)})`);
    check(plain(await page.$eval("#saved-note", (el) => el.textContent)) === "", "nothing changed yet: no Saved note");
    const qty = page.locator('#drawer input[data-field="qty"]').first();
    for (const value of ["4", "3"]) {
      await qty.fill(value);
      await qty.press("Tab");
      await page.waitForFunction(() => document.getElementById("saved-note").textContent.includes("Saved"), null, { timeout: 5000 }).catch(() => {});
      const note = await page.$eval("#saved-note", (el) => ({ text: el.textContent.replace(/\s+/g, " ").trim(), icon: Boolean(el.querySelector("svg.lucide")), shown: el.getBoundingClientRect().height > 0 }));
      check(note.text === "Saved" && note.icon && note.shown, `quantity ${value}: "Saved" with a check mark (${JSON.stringify(note)})`);
      if (value === "4") {
        await page.waitForTimeout(300); // the note's fade-in
        await shot("5-drawer-saved");
      }
    }
    const linaRow = (await (await page.request.get(`${base}/api/state`)).json()).orders.find((row) => row.buyer === "Lina");
    check(linaRow.qty === 3 && linaRow.lineTotal === "54.00", "both changes really reached the server (back to 3 boxes, RM 54.00)");
    // A refused change: the error shows, and no "Saved" for it.
    await qty.fill("0");
    await qty.press("Tab");
    await page.waitForSelector("#drawer-error:not([hidden])", { timeout: 5000 }).catch(() => {});
    check(plain(await page.$eval("#saved-note", (el) => el.textContent)) === "" && await page.isVisible("#drawer-error"), "a refused quantity (0): the error shows and no Saved note");
    await qty.fill("3");
    await qty.press("Tab");
    await page.waitForFunction(() => document.getElementById("saved-note").textContent.includes("Saved"), null, { timeout: 5000 }).catch(() => {});
    await page.click("#drawer-done");
    await page.waitForTimeout(300);
    check(await page.$eval("#drawer", (el) => el.hidden), "Done closes the drawer");
    await lina.locator(".chips").click();
    await page.waitForSelector("#drawer.is-open");
    check(plain(await page.$eval("#saved-note", (el) => el.textContent)) === "", "opened again: no old Saved note");
    await page.keyboard.press("Escape");

    // ---- Send -> the banner + (d) send each buyer their message ----
    await page.locator(SEND).click();
    await page.waitForFunction(() => /\d of 7 sent/.test(document.getElementById("send-message").textContent), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    check((await bannerText(page)) === BANNER, `the banner right after sending: "${await bannerText(page)}"`);
    check(await page.$eval("#sent-banner", (el) => el.getBoundingClientRect().height > 0), "the banner is on the page");
    const sentLine = plain(await page.$eval("#send-message", (el) => el.textContent));
    check(sentLine === "7 of 7 sent. Not sent: Priya, Jun Wei (need a check first).", `the send line leaves the instruction to the banner: "${sentLine}"`);
    await waitForLine(page, NEXT_TEXT.message);
    check((await nextLine(page)) === NEXT_TEXT.message, `(d) "${await nextLine(page)}"`);
    await page.$eval("#sent-banner", (el) => el.scrollIntoView({ block: "center" }));
    await shot("6-banner");
    const message = await showMe(page);
    check(message.kind === "message" && message.clear && message.pointed, `Show me: a buyer's Copy message (${JSON.stringify(message)})`);
    await shot("7-show-me-message");

    if (viewport.name === "phone") {
      // Got it hides the banner; the line still says to send the messages (Got it isn't sending them).
      await page.click("#sent-banner-close");
      await page.waitForTimeout(200);
      check((await bannerText(page)) === "" && (await nextLine(page)) === NEXT_TEXT.message, "Got it hides the banner; the guide still says to send the messages");
    }
    // Copy every buyer's message: the banner goes by itself, and (e) watch for Paid.
    check((await copyAll(page, "message")) === 7, "Copy message for the 7 sent buyers");
    await waitForLine(page, NEXT_TEXT.watch);
    check((await bannerText(page)) === "" && (await nextLine(page)) === NEXT_TEXT.watch, `every buyer has their message: the banner is gone, (e) "${await nextLine(page)}"`);
    const watch = await showMe(page);
    check(watch.id === "refresh-status" && watch.clear, `Show me: Refresh status (${JSON.stringify(watch)})`);
    // What was copied is remembered in this browser, for this batch.
    await page.reload();
    await page.waitForSelector(ROWS);
    await waitForLine(page, NEXT_TEXT.watch);
    check((await nextLine(page)) === NEXT_TEXT.watch, "after a reload the guide still knows the messages were sent");

    // ---- Everyone pays -> (f) pickup; all collected -> only the two amber buyers are left ----
    const state = await (await page.request.get(`${base}/api/state`)).json();
    const invoices = [...new Set(state.orders.filter((row) => row.invoiceId).map((row) => row.invoiceId))];
    for (const id of invoices) fake.pay(id);
    skip(11_000);
    await page.click("#refresh-status");
    await waitForLine(page, NEXT_TEXT.pickup);
    check((await nextLine(page)) === NEXT_TEXT.pickup, `(f) everyone paid: "${await nextLine(page)}"`);
    const pickup = await showMe(page);
    check(pickup.text === "Pickup scan" && pickup.clear, `Show me: Pickup scan (${JSON.stringify(pickup)})`);
    await page.evaluate(() => scrollTo(0, 0));
    await shot("8-guide-pickup");
    for (const invoiceId of invoices) await page.request.post(`${base}/api/pickup/collected`, { data: { invoiceId } });
    skip(11_000);
    await page.click("#refresh-status");
    await waitForLine(page, NEXT_TEXT.fixWaiting);
    check((await nextLine(page)) === NEXT_TEXT.fixWaiting, `all collected, Priya and Jun Wei still waiting for an answer: "${await nextLine(page)}"`);

    check(outside.length === 0, `nothing loaded from another site${outside.length ? `: ${outside.join(", ")}` : ""}`);
    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.close();
    server.closeAllConnections();
    server.close();
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: the guide, the banner and the drawer's Saved and Done all work.");
process.exitCode = failed ? 1 : 0;
