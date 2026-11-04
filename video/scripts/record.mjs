// Records the LIVE site (https://chatching.onrender.com/) at 1920 x 1080 for the demo video, following the
// storyboard in PLAN.md Section 13, scenes 2-7 (scenes 1, 8, 9 and 10 are made in Remotion).
//
//   2  Load demo: the chats and the Chat date
//   3  Read orders: the totals, Lina's change (her AI note), "same as Lina", Danish's cancellation, Jun Wei's amber price check
//   4  Priya: open her row, Copy question
//   5  Send invoices with the progress bar, then click again: nothing new
//   6  Lina's payer link: pay in the PayPal sandbox with the judge1 login from the README, back, Refresh status: Paid
//   7  Kitchen list
//
// It sends 7 REAL sandbox invoices (fictional buyers, fake money, no emails) and pays Lina's with judge1.
// No Gemini call: every POST /api/parse is stopped unless it is exactly the demo chats and date (the server
// answers those from its saved reply), and the run fails if "AI calls left" changes.
// The judge1 login is read from the README's "Judge test accounts" table; on PayPal's pages the login fields
// and any email address are blurred (lib/human.mjs), so they never show in the video.
//
// Output: out/raw/ (frames + recording.json), then clips.mjs makes public/clips/scene2.mp4 ... scene7.mp4.
// Run: npm run record            (or: npm run record -- https://another-url)
//      --judge=2         pay with the README's "Judge buyer 2" login instead of judge 1
//      --strict-version  stop unless the live version is the one in the app's package.json (npm run final uses this)
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Stream } from "./lib/stream.mjs";
import { INIT_SCRIPT, makeHuman } from "./lib/human.mjs";
import { buildClips } from "./clips.mjs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "https://chatching.onrender.com").replace(/\/$/, "");
const JUDGE = args.includes("--judge=2") ? 2 : 1;
const ROOT = new URL("../../", import.meta.url);
const RAW = fileURLToPath(new URL("../out/raw/", import.meta.url));
const DEMO = readFileSync(new URL("data/demo-chats.txt", ROOT), "utf8");
const DEMO_DATE = "2026-10-28";
const SIZE = { width: 1920, height: 1080 };
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const SLOW = 120_000;

const readme = readFileSync(new URL("README.md", ROOT), "utf8");
const login = readme.match(new RegExp(String.raw`\|\s*Judge buyer ${JUDGE}\s*\|\s*` + "`([^`]+)`" + String.raw`\s*\|\s*` + "`([^`]+)`" + String.raw`\s*\|`));
if (!login) throw new Error(`Could not find the "Judge buyer ${JUDGE}" row in the README's Judge test accounts table.`);
const [JUDGE_EMAIL, JUDGE_PASSWORD] = [login[1], login[2]];

// ---- markers: scenes, cut-outs (waiting), zoom moments, the PayPal popup ----
const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;
const marks = { scenes: [], skips: [], zooms: [], popups: [] };
let scene = null;
const startScene = (n) => {
  if (scene) scene.end = now();
  scene = { n, start: now() };
  marks.scenes.push(scene);
  console.log(`scene ${n} at ${now().toFixed(1)} s`);
};
// Cuts the dull middle of a wait, keeping `keep` seconds at each end so the change still reads.
const skip = (a, b, keep = 0.35) => { if (b - a > 2 * keep + 0.3) marks.skips.push([a + keep, b - keep]); };
const waitCut = async (promise, keep) => { const a = now(); const value = await promise; skip(a, now(), keep); return value; };
const union = (boxes) => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
};
// A zoom moment: Remotion eases in over 0.8 s, holds, eases out over 0.8 s. The page stays still meanwhile.
// `scale` fixes the zoom level; without it Remotion fits the box.
const zoom = async (box, hold = 2.2, scale) => {
  marks.zooms.push({ scene: scene.n, t: now(), hold, box, ...(scale ? { scale } : {}) });
  await sleep((hold + 1.7) * 1000);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The box around an element's words only (a full-width line would make the zoom too wide to notice).
const textBox = (page, sel) => page.$eval(sel, (el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const b = range.getBoundingClientRect();
  return { x: b.x - 14, y: b.y - 12, width: b.width + 28, height: b.height + 24 };
});
const unfocus = (page) => page.locator(".panel.orders .panel-head h2").first().click({ timeout: 2000 }).catch(() => {});

// ---- the browser ----
const health = await waitForSite();
const appVersion = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")).version;
console.log(`live version ${health.version} (package.json ${appVersion})${health.version === appVersion ? "" : "  <- not the same: the video shows what is live"}`);
if (args.includes("--strict-version") && health.version !== appVersion) {
  console.log("Stopped: Render is not running the new version yet. Wait for the deploy (CLAUDE.md Deploy steps), then run this again.");
  process.exit(1);
}

mkdirSync(RAW, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
await context.addInitScript(INIT_SCRIPT);
const main = new Stream("main", RAW, now, SIZE);
let popupStream = null;
const errors = [];
let failed = false;

try {
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));

  // The Gemini guard.
  let demoReads = 0;
  await page.route("**/api/parse", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.text?.trim() === DEMO.trim() && body.chatDate === DEMO_DATE && !body.withoutAi) {
      demoReads++;
      return route.continue();
    }
    errors.push("stopped a /api/parse request that was not the demo");
    return route.abort();
  });
  const state = async () => (await page.request.get(`${BASE}/api/state`)).json();

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector("#load-demo");
  await page.evaluate(() => document.fonts.ready);
  await sleep(1200);
  const aiBefore = (await state()).aiCallsLeft;
  await page.evaluate(() => scrollTo({ top: 230, behavior: "instant" })); // the chat card and both buttons in view
  const human = makeHuman(page);
  await human.show();
  await sleep(300);
  await main.attach(page);

  // ---------------- Scene 2: Load demo ----------------
  startScene(2);
  await sleep(700);
  await human.click("#load-demo", { after: 200 });
  await page.waitForFunction(() => document.getElementById("read-message").textContent.includes("Demo chats loaded"), null, { timeout: SLOW });
  await sleep(1000);
  await human.hover("#chat", 300);
  await page.$eval("#chat", async (box) => { // scroll slowly through the messy chats
    const end = box.scrollHeight - box.clientHeight;
    const t = performance.now();
    await new Promise((resolve) => {
      const step = (n) => { const p = Math.min(1, (n - t) / 2400); box.scrollTop = end * p; p < 1 ? requestAnimationFrame(step) : resolve(); };
      requestAnimationFrame(step);
    });
  });
  await sleep(300);
  await human.hover("#chat-date", 300);
  await zoom(union([await human.boxOf("#chat"), await human.boxOf("#chat-date")]), 1.8);

  // ---------------- Scene 3: Read orders ----------------
  startScene(3);
  await human.click("#read-orders", { after: 0 });
  await waitCut(page.waitForSelector(ROWS, { timeout: SLOW }), 0.9);
  await sleep(800);
  await human.scrollPageTo(186, 700); // the summary cards right under the top bar
  await human.moveTo(520, 420);
  await zoom(union([await human.boxOf("#stat-expected"), await human.boxOf("#stat-orders")]), 1.9); // the totals
  await human.scrollPageTo(700, 1100); // the table: Lina ... Priya
  const row = (buyer) => page.locator(ROWS, { hasText: buyer }).first();
  await human.click(row("Lina").locator(".chips"), { after: 300 });
  await page.waitForSelector("#drawer.is-open .chat-card", { timeout: SLOW });
  await sleep(700);
  await human.moveTo(1500, 360);
  await zoom(await human.boxOf("#drawer.is-open .chat-card"), 2.1); // "AI note: changed from 2 to 3 boxes"
  await page.keyboard.press("Escape");
  await unfocus(page);
  await sleep(500);
  await human.hover(row("Aisyah").locator(".chips"), 1100); // "same as Lina"
  await human.click("#page-next", { after: 700 });
  await human.hover(row("Danish"), 1100); // cancelled
  await human.hover(row("Jun Wei").locator(".chips"), 500);
  const jw = await human.boxOf(row("Jun Wei"));
  await human.moveTo(jw.x + jw.width - 40, jw.y + jw.height + 70); // off the row: hovering hides its amber tint
  await sleep(250);
  await zoom(union([await human.boxOf(row("Jun Wei").locator(".chips")), await human.boxOf(row("Jun Wei").locator(".check-text:visible"))]), 2.1); // amber: buyer mentioned RM 15.00, menu says RM 18.00

  // ---------------- Scene 4: Priya, Copy question ----------------
  startScene(4);
  await human.click("#page-prev", { after: 600 });
  await human.click(row("Priya").locator(".chips"), { after: 300 });
  await page.waitForSelector("#drawer.is-open #copy-question", { timeout: SLOW });
  await sleep(600);
  await human.reveal("#copy-question", { block: "center", ms: 1000 });
  await human.hover("#text-question", 300);
  await zoom(union([await human.boxOf("#text-question"), await human.boxOf("#copy-question")]), 2.0);
  await human.click("#copy-question", { after: 1100 });
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  console.log(`  copied: "${copied}"`);
  await page.keyboard.press("Escape");
  await unfocus(page);
  await sleep(600);

  // ---------------- Scene 5: Send invoices, then click again ----------------
  startScene(5);
  await human.scrollPageTo(186, 900);
  await human.hover("#send-invoices", 500);
  const sendAt = now();
  await human.click("#send-invoices", { after: 0 });
  await page.waitForFunction(() => /\d+ of \d+ sent/.test(document.getElementById("send-message").textContent), null, { timeout: SLOW * 2 });
  skip(sendAt + 4.5, now() - 1.5, 0); // the bar fills for a few seconds, then it jumps to the end
  await sleep(1400);
  const sent = (await state()).orders.filter((r) => r.invoiceId);
  console.log(`  ${new Set(sent.map((r) => r.invoiceId)).size} invoices sent`);
  await zoom(await textBox(page, "#send-message"), 1.8); // "7 of 7 sent ..."
  await human.click("#send-invoices", { after: 1600, reveal: false }); // "All invoices sent": disabled, nothing happens
  const again = (await state()).orders.filter((r) => r.invoiceId);
  if (new Set(again.map((r) => r.invoiceId)).size !== new Set(sent.map((r) => r.invoiceId)).size) throw new Error("A second click made new invoices.");

  // ---------------- Scene 6: Lina pays in the PayPal sandbox ----------------
  startScene(6);
  if (await page.locator("#page-prev").isEnabled().catch(() => false)) await human.click("#page-prev", { after: 700 });
  await human.scrollPageTo(186, 700);
  const payer = row("Lina").locator(".pay-link a");
  await human.hover(payer, 500);
  const tabOpened = context.waitForEvent("page");
  await human.click(payer, { after: 0 });
  const tab = await tabOpened;
  const tabHuman = makeHuman(tab, human.pos);
  const loadStart = now();
  await tab.waitForLoadState("load");
  const ppButtonFrame = tab.frameLocator('iframe[title*="PayPal"]').first();
  const ppButton = ppButtonFrame.locator('[data-funding-source="paypal"], div[role=link], [role=button]').first();
  await ppButton.waitFor({ state: "visible", timeout: SLOW });
  await tab.locator("#bannerCloseButton").click({ timeout: 3000 }).catch(() => {}); // PayPal's cookie banner
  await sleep(800);
  await main.attach(tab);
  await tabHuman.show();
  await sleep(300);
  skip(loadStart, now(), 0.1);
  await sleep(700);
  await tabHuman.hover('text="Amount due"', 600);
  const popupOpened = context.waitForEvent("page");
  await tabHuman.click(ppButton, { reveal: false, after: 0 });
  const popup = await popupOpened;
  const popStart = now();
  await tabHuman.hide();
  popupStream = new Stream("popup", RAW, now, popup.viewportSize() ?? { width: 568, height: 750 });
  await popupStream.attach(popup);
  // The login guard: every 100 ms (and after every typed key) it asks the popup whether the login fields and
  // any email address are blurred. If not, that moment is cut out of the video and reported.
  const leaks = [];
  const guardCheck = async () => {
    if (popup.isClosed()) return;
    const t = now();
    const ok = await popup.evaluate(() => (window.__loginBlurred ? window.__loginBlurred() : true)).catch(() => true);
    if (!ok) { leaks.push(t); skip(t - 0.6, t + 0.6, 0); }
  };
  const guard = setInterval(guardCheck, 100);
  const typeSecret = async (text, delay) => {
    for (const ch of text) {
      await popup.keyboard.type(ch);
      await guardCheck();
      await sleep(delay * (0.6 + Math.random() * 0.8));
    }
  };
  const ph = makeHuman(popup, { x: 284, y: 520 });
  await waitCut(popup.waitForSelector("#email", { state: "visible", timeout: SLOW }), 0.4);
  await ph.show();
  await sleep(300);
  await ph.click("#email", { after: 150 });
  let typing = now();
  await typeSecret(JUDGE_EMAIL, 40);
  skip(typing + 0.5, now() - 0.2, 0);
  await sleep(300);
  await ph.click("#btnNext", { after: 0 });
  await waitCut(popup.waitForSelector("#password", { state: "visible", timeout: SLOW }), 0.4);
  await sleep(250);
  await ph.click("#password", { after: 150 });
  typing = now();
  await typeSecret(JUDGE_PASSWORD, 50);
  skip(typing + 0.5, now() - 0.2, 0);
  await sleep(300);
  await ph.click("#btnLogin", { after: 0 });
  const submit = popup.locator("[data-testid=submit-button-initial], #payment-submit-btn").first();
  await waitCut(submit.waitFor({ state: "visible", timeout: SLOW }), 0.5);
  await sleep(1000);
  await ph.show();
  await ph.hover(submit, 600);
  const payAt = now();
  await ph.click(submit, { after: 0 });
  await popup.waitForEvent("close", { timeout: SLOW });
  clearInterval(guard);
  console.log(leaks.length ? `  login guard: ${leaks.length} unblurred moment(s) found and cut out` : "  login guard: the login stayed blurred the whole time");
  marks.popups.push({ scene: 6, start: popStart, end: now() });
  await popupStream.close();
  await tab.getByText("Payment successful", { exact: false }).first().waitFor({ timeout: SLOW });
  skip(payAt + 1.2, now() - 0.3, 0);
  await tabHuman.show();
  await sleep(1700);
  // Back to ChatChing: the PayPal tab closes, the app's tab is still there.
  await tab.close();
  await page.bringToFront();
  await main.attach(page);
  await human.show();
  await unfocus(page);
  await sleep(500);
  const paidWait = now();
  let paid = false;
  for (let attempt = 0; attempt < 6 && !paid; attempt++) {
    if (attempt) await sleep(11_000); // the server keeps a status for 10 s
    await human.click("#refresh-status", { after: 0 });
    paid = await page.waitForFunction((sel) => {
      const lina = [...document.querySelectorAll(sel)].find((r) => r.innerText.includes("Lina"));
      return lina && /^\s*Paid\s*$/m.test(lina.querySelector(".badge")?.innerText ?? "");
    }, ROWS, { timeout: 8000 }).then(() => true, () => false);
  }
  if (!paid) throw new Error("Lina never showed as Paid after Refresh status.");
  skip(paidWait + 1.0, now() - 0.6, 0);
  await sleep(600);
  await human.reveal(row("Lina"), { block: "center", ms: 800 });
  const linaRow = await human.boxOf(row("Lina"));
  const linaTag = await human.boxOf(row("Lina").locator(".badge"));
  await human.moveTo(linaTag.x + linaTag.width + 60, linaRow.y + linaRow.height + 60); // off the row
  await sleep(300);
  // Her name, total and the green Paid tag.
  await zoom({ x: linaRow.x, y: linaRow.y, width: linaTag.x + linaTag.width + 30 - linaRow.x, height: linaRow.height }, 2.4, 1.35);

  // ---------------- Scene 7: Kitchen list ----------------
  startScene(7);
  await human.click("#kitchen-list", { after: 300 });
  await page.waitForSelector("#drawer.is-open .kitchen-day", { timeout: SLOW });
  await sleep(1000);
  const days = page.locator("#drawer.is-open .kitchen-day");
  const dayBoxes = [];
  for (let i = 0; i < (await days.count()); i++) dayBoxes.push(await days.nth(i).boundingBox());
  await human.moveTo(1500, 500);
  await zoom(union(dayBoxes), 2.6);
  await sleep(800);
  scene.end = now();

  // Checks after the last frame.
  const aiAfter = (await state()).aiCallsLeft;
  console.log(`Gemini: ${demoReads} demo read(s) from the saved reply; AI calls left ${aiBefore} -> ${aiAfter}`);
  if (aiAfter !== aiBefore) { failed = true; console.log("FAIL: AI calls left changed."); }

  await main.close();
  // Tidy up: Reset demo clears this visitor's table (the invoices stay in the sandbox).
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#reset-demo").catch(() => {});
  await sleep(1000);
} catch (err) {
  failed = true;
  console.log(`FAIL: ${err.message}`);
  for (const [i, p] of context.pages().entries()) await p.screenshot({ path: `${RAW}error-${i}.png` }).catch(() => {});
} finally {
  await main.close().catch(() => {});
  await popupStream?.close().catch(() => {});
  await browser.close();
}

if (errors.length) console.log(`Page errors: ${errors.join(" | ")}`);
writeFileSync(`${RAW}recording.json`, JSON.stringify({ base: BASE, version: health.version, recordedAt: new Date().toISOString(), marks, streams: { main, popup: popupStream } }, null, 1));
console.log(`Raw frames: ${main.frames.length} main, ${popupStream?.frames.length ?? 0} popup -> out/raw/`);
if (failed) {
  console.log("Recording FAILED (see above). Screenshots: out/raw/error-*.png");
  process.exit(1);
}
await buildClips();

async function waitForSite() {
  const until = Date.now() + 150_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {}
    if (Date.now() > until) throw new Error(`${BASE} did not wake up.`);
    console.log("waiting for the free server to wake up...");
    await sleep(5000);
  }
}
