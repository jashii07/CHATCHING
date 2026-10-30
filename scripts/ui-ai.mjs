// The browser check for Step 9 (the AI's time budget and daily counter), at laptop and phone widths.
// The app runs in REAL AI mode, but Gemini is a FAKE fetch that this script answers by hand, so no real
// AI call is ever made and we decide exactly when each call answers:
//   Busy: main 503 -> main again 503 -> backup. The words go "Reading the chats..." then "The AI is busy,
//         trying the backup..."; the button stays disabled the whole time; at the end the friendly notice,
//         the rows unchanged, the top bar counts the 3 failed calls (40 -> 37).
//   Used up: the counter at 0 -> no call, "Today's free AI reads are used up..."; Load demo + Read orders
//         still work (the saved reply, 0 calls).
// It fails on any console error or warning. Run: npm run ui-ai (uses the installed Google Chrome).
// Each width gets its own store and counter file in tmp/. Screenshots go to tmp/screenshots-ai/.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AI_BUSY, createAi, usedUp } from "../src/ai.js";
import { BACKUP_MODEL, MAIN_MODEL } from "../src/gemini.js";
import { createUsage, DAILY_LIMIT } from "../src/usage.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";

const OUT = fileURLToPath(new URL("../tmp/screenshots-ai/", import.meta.url));
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const CHATS = "[30/10 9:00 AM] Zara: 2 jars of cookies for saturday pls";

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
  const server = createApp(loadConfig({ AI_MODE: "real" }), { log: () => {}, storeFile: `${OUT}${name}-orders.json`, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, gemini, usage };
}

const readMessage = async (page) => plain(await page.$eval("#read-message", (el) => el.textContent));
const callsText = async (page) => plain(await page.$eval("#ai-calls-text", (el) => el.textContent));
const buttonBusy = (page) => page.$eval("#read-orders", (el) => el.disabled && el.getAttribute("aria-busy") === "true");
const rowTexts = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()).sort().join("|"));

try {
  for (const viewport of WIDTHS) {
    const { server, gemini, usage } = await startServer(viewport.name);
    const base = `http://localhost:${server.address().port}`;
    const page = await browser.newPage({ viewport });
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
    await page.click("#read-orders");
    await gemini.nextCall(1);
    check((await readMessage(page)) === "Reading the chats..." && (await buttonBusy(page)), `while the main model works: "${await readMessage(page)}", button disabled`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-1-reading.png`, fullPage: true });
    gemini.answer(503);
    await gemini.nextCall(2); // the main model once more
    await page.waitForTimeout(1300); // one poll
    check((await readMessage(page)) === "Reading the chats..." && (await buttonBusy(page)), "the retry of the main model still says \"Reading the chats...\"");
    gemini.answer(503);
    await gemini.nextCall(3); // the backup
    await page.waitForFunction(() => document.getElementById("read-message").textContent === "The AI is busy, trying the backup...", null, { timeout: 5000 }).catch(() => {});
    check((await readMessage(page)) === "The AI is busy, trying the backup..." && (await buttonBusy(page)), `then: "${await readMessage(page)}", button still disabled`);
    check((await callsText(page)) === "AI calls left today: 37", `the top bar counts the calls as they start: "${await callsText(page)}"`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-2-backup.png`, fullPage: true });
    gemini.answer(503);
    await page.waitForFunction((busy) => document.getElementById("read-message").textContent === busy, AI_BUSY, { timeout: 5000 }).catch(() => {});
    check((await readMessage(page)) === AI_BUSY, `both busy: "${await readMessage(page)}"`);
    check(!(await page.$eval("#read-orders", (el) => el.disabled)), "the button works again");
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

    // --- Step 10: Read without AI. The demo chats on ANOTHER Chat date are not the saved reply, so the AI is
    //     asked (used up: no call); the seller clicks Read without AI: simple rules, careful, never a wrong total.
    const demoText = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
    await page.fill("#chat", demoText);
    await page.fill("#chat-date", "2026-10-29");
    await page.click("#read-orders");
    await page.waitForFunction(() => document.getElementById("read-message").textContent.startsWith("Today's free"), null, { timeout: 5000 }).catch(() => {});
    check(await page.isVisible("#read-without-ai"), "the demo chats on 29 Oct: used up, Read without AI offered");
    check(await page.$eval("#fallback-note", (el) => el.hidden), "no banner before the seller chooses");
    await page.click("#read-without-ai");
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
    await page.click("#read-orders");
    await page.waitForSelector("#chats[hidden]", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    check((await readMessage(page)) === "" && (await page.$$(ROWS)).length > 0, "at 0, Load demo + Read orders still fills the table (saved reply)");
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
  const limitServer = createApp(loadConfig({}), { log: () => {}, storeFile: `${OUT}limit-orders.json`, limiter: createRateLimiter({ limits: tight }) }).listen(0);
  await new Promise((resolve) => limitServer.once("listening", resolve));
  const page = await browser.newPage({ viewport: WIDTHS[0] });
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
  const saved = async () => JSON.stringify((await (await fetch(`http://localhost:${limitServer.address().port}/api/state`)).json()).orders);
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
