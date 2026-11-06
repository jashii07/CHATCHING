// The browser check for Step 9 (the AI's time budget and daily counter), at laptop and phone widths.
// The app runs in REAL AI mode, but Gemini is a FAKE fetch that this script answers by hand, so no real
// AI call is ever made and we decide exactly when each call answers:
//   Busy: main 503 -> main again 503 -> backup. The words go "Reading the chats... Long chats can take up
//         to a minute." then "The AI is busy,
//         trying the backup..."; the button stays disabled the whole time; at the end the friendly notice,
//         the rows unchanged, the top bar counts the 3 failed calls (40 -> 37).
//   Used up: the counter at 0 -> no call, "Today's free AI reads are used up..."; Load demo + Read orders
//         still work (the saved reply, 0 calls).
// It fails on any console error or warning. Run: npm run ui-ai (uses the installed Google Chrome).
// Each width gets its own test visitor (the demo table) and counter file. Screenshots go to tmp/screenshots-ai/.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AI_BUSY, createAi, usedUp } from "../src/ai.js";
import { BACKUP_MODEL, MAIN_MODEL } from "../src/gemini.js";
import { createUsage, DAILY_LIMIT } from "../src/usage.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { testVisitor, visitorPage } from "./test-visitor.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-ai/", import.meta.url));
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const CHATS = "[30/10 9:00 AM] Zara: 2 jars of cookies for saturday pls";
const READING = "Reading the chats... Long chats can take up to a minute.";
// A long paste: n messages, each padded to size characters.
const longChats = (n, size) => Array.from({ length: n }, (_, i) => `[30/10 9:${String(i % 60).padStart(2, "0")} AM] Buyer ${i}: `.padEnd(size, "x")).join("\n");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim();

// A fake Gemini whose calls wait until the script answers them: answer(503) answers the oldest one.
function handGemini() {
  const waiting = [];
  const models = [];
  let arrived = () => {};
  async function fetch(url) {
    models.push(url.match(/models\/(.+):generateContent/)[1]);
    arrived();
    const status = await new Promise((resolve) => waiting.push(resolve));
    return new Response(JSON.stringify({ error: { code: status, status: "UNAVAILABLE", message: "high demand" } }), { status });
  }
  const nextCall = (n) => new Promise((resolve) => {
    arrived = () => models.length >= n && resolve();
    arrived();
  });
  return { fetch, models, nextCall, answer: (status) => waiting.shift()(status) };
}

async function startServer(name) {
  const gemini = handGemini();
  const usage = createUsage({ file: `${OUT}${name}-ai-usage.json`, models: [MAIN_MODEL, BACKUP_MODEL], log: () => {} });
  // sleep: no real 2 s wait before the retry (the timing itself is tested in test/ai-real.test.js).
  const ai = createAi({ mode: "real", apiKey: "fake-gemini-key", fetch: gemini.fetch, usage, sleep: async () => {}, cacheDir: `${OUT}${name}-ai-cache`, log: () => {} });
  const visitor = testVisitor();
  const server = createApp(loadConfig({ AI_MODE: "real" }), { log: () => {}, visitorsDir: visitor.dir, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, gemini, usage, visitor };
}

const readMessage = async (page) => plain(await page.$eval("#read-message", (el) => el.textContent));
const callsText = async (page) => plain(await page.$eval("#ai-calls-text", (el) => el.textContent));
const buttonBusy = (page) => page.$eval("#read-orders", (el) => el.disabled && el.getAttribute("aria-busy") === "true");
const rowTexts = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()).sort().join("|"));
// The loading card (6 Nov): what it says, where it is, and whether it moves.
const readingCard = (page) => page.evaluate(() => {
  const card = document.getElementById("reading-card");
  const text = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, " ").trim() ?? "";
  const box = card?.getBoundingClientRect();
  const orders = document.querySelector(".panel.orders").getBoundingClientRect();
  const grid = document.getElementById("grid");
  const hint = document.getElementById("read-message");
  // On phones the sticky total bar covers the bottom of the screen, and the top bar the top.
  const bar = document.getElementById("phone-total");
  const bottom = getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : innerHeight;
  const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
  return {
    shown: Boolean(card && !card.hidden),
    title: text("reading-title"),
    stage: text("reading-stage"),
    time: text("reading-time"),
    inView: Boolean(box && box.height > 0 && box.top >= top && box.bottom <= bottom),
    overOrders: Boolean(box && box.top >= orders.top && box.bottom <= orders.bottom && box.top < grid.getBoundingClientRect().top + 1),
    dimmed: Number(getComputedStyle(grid).opacity) < 0.5,
    dots: getComputedStyle(card?.querySelector(".typing span") ?? document.body).animationName,
    cardAnimation: card ? getComputedStyle(card).animationName : "",
    quietHint: hint.classList.contains("is-quiet") && hint.getBoundingClientRect().height <= 1,
  };
});

try {
  for (const viewport of WIDTHS) {
    const { server, gemini, usage, visitor } = await startServer(viewport.name);
    const base = `http://localhost:${server.address().port}`;
    const page = await visitorPage(browser, visitor, base, { viewport });
    const errors = [];
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));

    console.log(`\n${viewport.width} px (${viewport.name})`);
    await page.goto(base);
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(400);
    check((await callsText(page)) === "AI calls left today: 40", `the top bar starts at "${await callsText(page)}"`);
    // --- Busy: main 503, main again 503, backup 503 ---
    await page.click("#chat-edit");
    await page.waitForTimeout(400);
    // Taken with the chats open: opening them can move the date under the name (a narrower table).
    const before = await rowTexts(page);
    await page.fill("#chat", CHATS);
    await page.fill("#chat-date", "2026-10-30");
    const clickedAt = Date.now();
    await page.click("#read-orders");
    await gemini.nextCall(1);
    check((await readMessage(page)) === READING && (await buttonBusy(page)), `while the main model works: "${await readMessage(page)}", button disabled`);
    // The loading card (6 Nov, user test: a slow read looked like a crash): over the orders area, the number of
    // messages, the server's real stage and a seconds counter; the table under it dimmed; scrolled into view.
    await page.waitForSelector("#reading-card:not([hidden])", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1300); // the count arrives with the next progress check; the dots and the clock move
    const card = await readingCard(page);
    check(card.shown && card.title === "Reading 1 message..." && card.stage === "The AI is reading them now. Long chats can take up to a minute."
      && /^\d+ s, usually 20-40 s$/.test(card.time), `the loading card: ${JSON.stringify(card)}`);
    check(card.inView && card.overOrders && card.dimmed && card.dots === "typing", `in view, over the orders area, the table dimmed, the dots move (${JSON.stringify(card)})`);
    check((await readMessage(page)) === READING && card.quietHint, "the words under the button move into the card (still read out to screen readers)");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-1-reading.png` }); // what the seller sees mid-loading
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-1-reading-full.png`, fullPage: true });
    const firstSecond = Number(card.time.split(" ")[0]);
    await page.waitForTimeout(2100);
    const later = await readingCard(page);
    const elapsed = Math.floor((Date.now() - clickedAt) / 1000);
    check(Number(later.time.split(" ")[0]) >= firstSecond + 2 && Number(later.time.split(" ")[0]) <= elapsed, `the seconds count up: "${card.time}" -> "${later.time}" (${elapsed} s since the click)`);
    // With reduced motion: no moving dots, no fade; the seconds still count.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const calm = await readingCard(page);
    await page.waitForTimeout(1100);
    const calmLater = await readingCard(page);
    check(calm.dots === "none" && calm.cardAnimation === "none" && calmLater.time !== calm.time, `reduced motion: still dots, the counter still counts ("${calm.time}" -> "${calmLater.time}")`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-1b-reading-reduced-motion.png` });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    gemini.answer(503);
    await gemini.nextCall(2); // the main model once more
    await page.waitForTimeout(1300); // one poll
    check((await readMessage(page)) === READING && (await buttonBusy(page)), "the retry of the main model still says the reading words");
    gemini.answer(503);
    await gemini.nextCall(3); // the backup
    await page.waitForFunction(() => document.getElementById("read-message").textContent === "The AI is busy, trying the backup...", null, { timeout: 5000 }).catch(() => {});
    check((await readMessage(page)) === "The AI is busy, trying the backup..." && (await buttonBusy(page)), `then: "${await readMessage(page)}", button still disabled`);
    const backupCard = await readingCard(page);
    check(backupCard.shown && backupCard.stage === "The AI is busy, trying the backup..." && backupCard.title === "Reading 1 message...", `the card shows the server's new stage: "${backupCard.stage}"`);
    check((await callsText(page)) === "AI calls left today: 37", `the top bar counts the calls as they start: "${await callsText(page)}"`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-2-backup.png` });
    gemini.answer(503);
    await page.waitForFunction((busy) => document.getElementById("read-message").textContent === busy, AI_BUSY, { timeout: 5000 }).catch(() => {});
    check((await readMessage(page)) === AI_BUSY, `both busy: "${await readMessage(page)}"`);
    check(!(await page.$eval("#read-orders", (el) => el.disabled)), "the button works again");
    await page.waitForTimeout(300); // the table fades back in (200 ms)
    const after = await readingCard(page);
    check(!after.shown && !after.dimmed && !after.quietHint, `the card is gone, the table is no longer dimmed, the notice shows under the button (${JSON.stringify(after)})`);
    check(gemini.models.join(",") === [MAIN_MODEL, MAIN_MODEL, BACKUP_MODEL].join(","), `3 calls: ${gemini.models.join(", ")}`);
    check((await rowTexts(page)) === before, "the rows are unchanged");
    check(await page.isVisible("#read-without-ai"), "the notice offers Read without AI (the seller chooses; nothing happens by itself)");
    check((await page.$eval("#error", (el) => el.hidden).catch(() => true)), "no red error box");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-3-busy.png`, fullPage: true });

    // --- Used up: every model at its limit ---
    for (const model of [MAIN_MODEL, BACKUP_MODEL]) while (usage.left(model) > 0) usage.take(model);
    await page.fill("#chat", `${CHATS}\n[30/10 9:05 AM] Ben: 1 cheese brownies`);
    await page.click("#read-orders");
    await page.waitForFunction(() => document.getElementById("read-message").textContent.startsWith("Today's free"), null, { timeout: 5000 }).catch(() => {});
    check((await readMessage(page)) === usedUp(Date.now()), `used up: "${await readMessage(page)}"`);

    await page.waitForTimeout(300);
    check((await callsText(page)) === "AI calls left today: 0", `the top bar: "${await callsText(page)}"`);
    check(gemini.models.length === 3, "no call at 0");
    check((await rowTexts(page)) === before, "the rows are still unchanged");
    check(await page.isVisible("#read-without-ai"), "used up: Read without AI is offered too");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-4-used-up.png`, fullPage: true });

    // --- The limits in the browser. The counter is at 0, so a paste the limits allow reaches the AI step
    // and gets the used-up words, with no call. (The page has its own copy of the character limit.)
    const notice = async (text) => {
      await page.fill("#chat", text);
      await page.click("#read-orders");
      await page.waitForFunction((old) => !document.getElementById("read-orders").disabled && document.getElementById("read-message").textContent !== old, "", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      return readMessage(page);
    };
    const fits = await notice(longChats(120, 120)); // 120 messages, about 14,500 characters
    check(fits === usedUp(Date.now()), `120 messages over 10,000 characters are accepted: "${fits}"`);
    const tooMany = await notice(longChats(121, 40));
    check(tooMany === "That's 121 messages. ChatChing reads up to 120 at a time, so please paste fewer.", `121 messages: "${tooMany}"`);
    const tooLong = await notice("x".repeat(15_001));
    check(tooLong === "That paste is 15,001 characters. ChatChing reads up to 15,000 at a time, so please paste fewer messages.", `15,001 characters: "${tooLong}"`);

    // --- Step 10: Read without AI. The demo chats on ANOTHER Chat date are not the saved reply, so the AI is
    //     asked (used up: no call); the seller clicks Read without AI: simple rules, careful, never a wrong total.
    const demoText = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
    await page.fill("#chat", demoText);
    await page.fill("#chat-date", "2026-10-29");
    await page.click("#read-orders");
    await page.waitForFunction(() => document.getElementById("read-message").textContent.startsWith("Today's free"), null, { timeout: 5000 }).catch(() => {});
    check(await page.isVisible("#read-without-ai"), "the demo chats on 29 Oct: used up, Read without AI offered");
    check(await page.$eval("#fallback-note", (el) => el.hidden), "no banner before the seller chooses");
    // Held for 1.5 s here (it is normally quick), so the card's own words for it can be seen.
    await page.route("**/api/parse", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.click("#read-without-ai");
    await page.waitForSelector("#reading-card:not([hidden])", { timeout: 5000 }).catch(() => {});
    const plainCard = await readingCard(page);
    check(plainCard.shown && plainCard.title === "Reading your messages without AI..." && plainCard.stage === "Simple rules, no AI call."
      && /^\d+ s, usually a second or two$/.test(plainCard.time), `Read without AI has the card too: ${JSON.stringify(plainCard)}`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-4b-reading-without-ai.png` });
    await page.waitForSelector("#reading-card[hidden]", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.unroute("**/api/parse");
    await page.waitForSelector("#fallback-note:not([hidden])", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const banner = plain(await page.$eval("#fallback-note", (el) => (el.hidden ? "" : el.innerText)));
    check(banner === "Read without AI. Changes and cancellations may be missed, so please check every row.", `the amber banner above the table: "${banner}"`);
    check(await page.$eval("#fallback-note", (el) => getComputedStyle(el).backgroundColor === "rgb(252, 239, 214)"), "the banner is amber");
    const amber = await page.$$eval(ROWS, (els) => els.filter((el) => el.classList.contains("row-unclear")).length);
    const shown = (await page.$$(ROWS)).length;
    check(shown === 6 && amber === 5, `page 1: ${amber} of ${shown} rows amber (only Mei Ling is clear)`);
    const meiLing = plain(await page.locator(ROWS, { hasText: "Mei Ling" }).innerText());
    check(meiLing.includes("1 × Cheese brownies") && meiLing.includes("2 × Choc chip cookies") && meiLing.includes("RM 72.00") && !meiLing.includes("Check:"),
      `Mei Ling read right and clear: "${meiLing}"`);
    const lina = plain(await page.locator(ROWS, { hasText: "Lina" }).innerText());
    check(lina.includes("Check: read without AI, this buyer changed their order."), `Lina says why: "${lina}"`);
    const cardsText = plain(await page.$eval(".summary", (el) => el.innerText));
    check(cardsText.includes("Expected RM 72.00") && cardsText.includes("Needs check 9"), `summary: RM 72.00 ready, 9 to check: "${cardsText}"`);
    const footer = plain(await page.$eval("#setup", (el) => el.innerText));
    check(footer.includes("AI mode: read without AI"), `footer: "${footer}"`);
    check(gemini.models.length === 3, "Read without AI made no AI call");
    check(!(await page.isVisible("#read-without-ai")) && (await readMessage(page)) === "", "the button and the notice are gone");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-5-without-ai.png`, fullPage: true });
    // A reload keeps the rows and still says how they were read.
    await page.reload();
    await page.waitForSelector(ROWS);
    await page.waitForTimeout(400);
    check(!(await page.$eval("#fallback-note", (el) => el.hidden)) && plain(await page.$eval("#setup", (el) => el.innerText)).includes("AI mode: read without AI"),
      "after a reload: still the banner and the footer note");
    await page.click("#chat-edit");

    await page.click("#load-demo");
    // The chat box already holds the demo text, so wait for Load demo's own Chat date.
    await page.waitForFunction(() => document.getElementById("chat-date").value === "2026-10-28", null, { timeout: 5000 });
    // A quick read (the saved demo reply) must not flash the loading card: it only appears after 400 ms.
    await page.evaluate(() => {
      window.cardSeen = false;
      new MutationObserver(() => (window.cardSeen ||= !document.getElementById("reading-card").hidden))
        .observe(document.getElementById("reading-card"), { attributes: true });
    });
    await page.click("#read-orders");
    await page.waitForSelector("#chats[hidden]", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    check((await readMessage(page)) === "" && (await page.$$(ROWS)).length > 0, "at 0, Load demo + Read orders still fills the table (saved reply)");
    check(!(await page.evaluate(() => window.cardSeen)), "a quick read never flashes the loading card");
    check(gemini.models.length === 3, "still no new call");
    check(await page.$eval("#fallback-note", (el) => el.hidden) && plain(await page.$eval("#setup", (el) => el.innerText)).includes("AI mode: real"),
      "an AI read again: no banner, the footer says AI mode: real");

    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.close();
    server.closeAllConnections();
    server.close();
  }

  // Step 11: too many reads from one visitor (a limit of 1 here, 6 in the app) -> friendly words and the
  // Read without AI button, rows unchanged, no red console line. Mock mode: the demo's saved reply.
  console.log("\nToo many reads from one visitor (rate limit, Step 11)");
  const tight = Object.fromEntries(Object.keys(RATE_LIMITS).map((route) => [route, { limit: 1, windowMs: 10 * 60_000 }]));
  const limitVisitor = testVisitor();
  const limitServer = createApp(loadConfig({}), { log: () => {}, visitorsDir: limitVisitor.dir, limiter: createRateLimiter({ limits: tight }) }).listen(0);
  await new Promise((resolve) => limitServer.once("listening", resolve));
  const page = await visitorPage(browser, limitVisitor, `http://localhost:${limitServer.address().port}`, { viewport: WIDTHS[0] });
  const errors = [];
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`http://localhost:${limitServer.address().port}`);
  await page.waitForSelector(ROWS);
  const readOnce = async () => {
    await page.click("#chat-edit");
    await page.click("#load-demo");
    await page.waitForFunction(() => document.getElementById("chat-date").value === "2026-10-28", null, { timeout: 5000 });
    await page.click("#read-orders");
    await page.waitForFunction(() => !document.getElementById("read-orders").disabled, null, { timeout: 5000 });
    await page.waitForTimeout(300);
  };
  await readOnce();
  check((await readMessage(page)) === "" && (await page.$$(ROWS)).length > 0, "the 1st read works");
  const saved = async () => JSON.stringify((await (await limitVisitor.fetch(`http://localhost:${limitServer.address().port}/api/state`)).json()).orders);
  const before = await saved();
  await readOnce();
  const words = await readMessage(page);
  check(words === slowDown(10 * 60_000), `the 2nd read gets friendly words: "${words}"`);
  check(await page.isVisible("#read-without-ai"), "and the Read without AI button (it makes no AI call, so it is never limited)");
  check((await saved()) === before, "the saved orders are unchanged (nothing was read)");
  await page.screenshot({ path: `${OUT}1280-laptop-6-rate-limit.png`, fullPage: true });
  check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await page.close();
  limitServer.closeAllConnections();
  limitServer.close();
} finally {
  await browser.close();
}
console.log(failed ? `\nFAIL: ${failed} check(s) failed.` : `\nPASS: all checks passed. Screenshots in tmp/screenshots-ai/ (limit ${DAILY_LIMIT} per model).`);
process.exitCode = failed ? 1 : 0;
