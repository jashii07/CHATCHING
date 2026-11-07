// The browser check for the design polish day (8 Nov), at 1280 x 800, 820 and 390 x 844 px:
//   Motion: the drawer slides in and out (seen mid-slide), buttons press in, rows and figures come in after Read orders.
//   Cha-ching: a buyer turns Paid -> their tag pops, the Paid card counts up, a coin sound plays (Web Audio, counted by
//           a spy); never before a click on the page; Mute silences it and is remembered after a reload.
//   Reduced motion: no slide, no entrance, no pop, no count-up (the number just changes), no sound, no mute toggle.
//   Waking up: /api/state answers 503 -> "Waking up the server...", no active Send, no "..." counter, then it loads;
//           never answering -> plain words after ~30 s; the buyer's page waits the same way.
//   Leftovers: "(cash/bank)" stays on one line of its tag at 1280, 1024, 820 and 768 px; the About this demo line.
//   A11y sweep: every tap target at least 44 x 44 px, text contrast (WCAG AA), the placeholder's contrast.
// PayPal is the FAKE in scripts/fake-paypal.mjs. Fails on any console error or warning (expected 503s aside).
// Run: npm run ui-polish. Screenshots: tmp/screenshots-polish/ (git-ignored).
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "./fake-paypal.mjs";
import { testVisitor, visitorPage } from "./test-visitor.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-polish/", import.meta.url));
const KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const SIZES = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "ipad", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => String(text).replace(/\s+/g, " ").trim();

async function startServer(visitorsDir) {
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: KEYS.PAYPAL_CLIENT_ID, clientSecret: KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  let skew = 0;
  const server = createApp(loadConfig(KEYS), { log: () => {}, visitorsDir, paypal, now: () => Date.now() + skew }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, fake, base: `http://localhost:${server.address().port}`, skip: (ms) => (skew += ms) };
}

// Before the page's own scripts: count every AudioContext and oscillator (6 per cha-ching), and record every value
// the Paid figure shows (a count-up leaves in-between values behind).
function spy() {
  window.__sound = { contexts: 0, notes: 0 };
  const Real = window.AudioContext;
  if (Real) {
    window.AudioContext = class extends Real {
      constructor(...args) {
        super(...args);
        window.__sound.contexts++;
      }
      createOscillator() {
        window.__sound.notes++;
        return super.createOscillator();
      }
    };
  }
  window.__paidFrames = [];
  document.addEventListener("DOMContentLoaded", () => {
    const figure = document.querySelector("#stat-paid [data-figure]");
    if (figure) new MutationObserver(() => window.__paidFrames.push(figure.textContent.replace(/\s+/g, " "))).observe(figure, { childList: true, characterData: true, subtree: true });
  });
}

function watch(page, errors, allowed = []) {
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && !allowed.some((re) => re.test(msg.text())) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
}

const contextOptions = (size, extra = {}) => ({
  viewport: { width: size.width, height: size.height },
  ...(size.name === "phone" && { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  ...extra,
});

const sound = (page) => page.evaluate(() => ({ ...window.__sound }));
const stateNow = (page) => page.evaluate(() => fetch("/api/state").then((r) => r.json()));
const invoiceOf = async (page, buyer) => (await stateNow(page)).orders.find((row) => row.buyer === buyer && row.invoiceId)?.invoiceId;
const visible = (page, selector) => page.locator(`${selector}:visible`).first();

async function goToBuyer(page, buyer) {
  for (let i = 0; i < 3 && !(await page.locator(ROWS, { hasText: buyer }).count()); i++) {
    const next = !(await page.$eval("#page-next", (el) => el.disabled));
    await page.click(next ? "#page-next" : "#page-prev");
    await page.waitForTimeout(250);
  }
}

// A buyer pays in the fake sandbox; the seller clicks Refresh status (a click, so sound is allowed).
async function pays(page, run, buyer) {
  await goToBuyer(page, buyer);
  run.fake.pay(await invoiceOf(page, buyer));
  run.skip(11_000); // past the server's 10-second status cache
  await page.evaluate(() => (window.__paidFrames = []));
  await visible(page, "#refresh-status").click();
  await page.waitForFunction((name) => document.getElementById("status-message").textContent.includes(`Paid: ${name}`), buyer, { timeout: 5000 }).catch(() => {});
}

// How many lines "(cash/bank)" takes inside its tag (1 = kept together).
const cashBankLines = (page) => page.evaluate(() => {
  const tag = [...document.querySelectorAll("#grid .badge-paid-cash-bank")].find((t) => t.getClientRects().length);
  const node = tag && [...tag.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes("(cash/bank)"));
  if (!node) return null;
  const range = document.createRange();
  const at = node.textContent.indexOf("(cash/bank)");
  range.setStart(node, at);
  range.setEnd(node, at + "(cash/bank)".length);
  return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
});

// Every visible button, link and field is at least 44 x 44 px, counting a hit area widened by ::after. A link inside a
// sentence (the About line's README) is the WCAG inline exception.
const smallTargets = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary")) {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden" || el.closest("footer .about")) continue;
    const box = el.getBoundingClientRect();
    let [w, h] = [box.width, box.height];
    const after = getComputedStyle(el, "::after");
    if (after.content !== "none" && after.position === "absolute") {
      const out = (v) => Math.max(0, -(parseFloat(v) || 0));
      w += out(after.left) + out(after.right);
      h += out(after.top) + out(after.bottom);
    }
    if (Math.round(w) < 44 || Math.round(h) < 44) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(w)}x${Math.round(h)}`);
  }
  return out;
});

// Text contrast against the first solid background behind it (WCAG AA: 4.5:1, or 3:1 for large text). Text on the
// indigo gradient card is skipped here (measured by hand: 11.76 / 8.97 / 6.31, PLAN.md Section 12); disabled buttons too.
const lowContrast = (page) => page.evaluate(() => {
  const rgb = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const background = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none" && n !== document.body) return null;
      const c = rgb(s.backgroundColor);
      if (c.length === 3 || c[3] > 0.5) return c.slice(0, 3);
    }
    return [247, 245, 242];
  };
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || seen.has(el) || !el.getClientRects().length) continue;
    seen.add(el);
    if (el.closest("button:disabled, [aria-hidden=true], .ag-hidden, .is-reading")) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden") continue;
    const bg = background(el);
    if (!bg) continue;
    const size = parseFloat(s.fontSize);
    const need = size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
    const r = ratio(rgb(s.color).slice(0, 3), bg);
    if (r < need) out.push(`"${walker.currentNode.textContent.trim().slice(0, 28)}" ${r.toFixed(2)}:1`);
  }
  return out;
});

const placeholderRatio = (page, selector) => page.$eval(selector, (el) => {
  const rgb = (c) => (c.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3);
  const lum = (c) => c.map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [a, b] = [lum(rgb(getComputedStyle(el, "::placeholder").color)), lum(rgb(getComputedStyle(el).backgroundColor))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
});

try {
  // ---- 1. The whole polish at each width: an empty table, Read orders, the drawer, send, pay, mute ----
  for (const size of SIZES) {
    console.log(`\n${size.width} px (${size.name})`);
    const run = await startServer(testVisitor({ rows: [] }).dir);
    const context = await browser.newContext(contextOptions(size));
    await context.addInitScript(spy);
    const page = await context.newPage();
    const errors = [];
    watch(page, errors);
    const shot = (name, fullPage = false) => page.screenshot({ path: `${OUT}${size.width}-${size.name}-${name}.png`, fullPage });
    await page.goto(run.base);
    await page.waitForSelector(".ag-overlay");
    check(!(await page.$eval("#ai-calls", (el) => el.hidden)) && /AI calls left today: \d+/.test(await page.$eval("#ai-calls", (el) => el.innerText)), "the AI counter shows a real number once loaded");
    check((await page.$$("#sound-toggle:not([hidden]) svg.lucide")).length === 1 && (await page.$eval("#sound-toggle", (el) => el.getAttribute("aria-label"))) === "Payment sound",
      "the mute toggle on the Paid card: a speaker icon, labelled Payment sound");

    // Read orders: the rows and the summary figures come in, a short rise and fade.
    await page.click("#load-demo");
    await page.waitForFunction(() => document.getElementById("chat").value.length > 100);
    await page.click("#read-orders");
    await page.waitForSelector(`#grid.is-entering ${ROWS}`, { timeout: 5000 }).catch(() => {});
    const entering = await page.evaluate((rows) => ({
      rows: [...document.querySelectorAll(rows)].map((r) => getComputedStyle(r).animationName),
      delays: [...document.querySelectorAll(rows)].slice(0, 3).map((r) => getComputedStyle(r).animationDelay),
      figure: getComputedStyle(document.querySelector("#stat-orders [data-figure]")).animationName,
    }), ROWS);
    await page.waitForTimeout(60);
    await shot("1-entering-mid");
    check(entering.rows.length > 0 && entering.rows.every((name) => name === "enter-up") && entering.figure === "enter-up", `after Read orders the rows and figures come in (${JSON.stringify(entering)})`);
    check(entering.delays.join() === "0s,0.035s,0.07s", `a short stagger, 35 ms apart (${entering.delays.join()})`);
    await page.waitForTimeout(800);
    check(!(await page.$eval("#grid", (el) => el.classList.contains("is-entering"))), "the entrance is over after 700 ms (a status check later never replays it)");
    await shot("2-read", true);

    // A button presses in at once.
    // A button presses in at once (held down with the mouse; headless Chrome gives synthetic touches no :active, so the
    // iPhone's touch press is a real-phone check).
    const button = visible(page, "#export-csv");
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const pressed = await button.evaluate((el) => getComputedStyle(el).transform);
    await page.mouse.up();
    check(/^matrix\(0\.97, 0, 0, 0\.97/.test(pressed), `a pressed button scales to 97% (${pressed})`);

    // The drawer slides in from the right with the dim behind it, and slides back out.
    await goToBuyer(page, "Lina");
    const tableLeft = () => page.$eval(".panel.orders", (el) => Math.round(el.getBoundingClientRect().left));
    const leftBefore = await tableLeft();
    await page.locator(ROWS, { hasText: "Lina" }).locator(".chips").click();
    const opened = await page.$eval("#drawer", (el) => el.classList.contains("is-open") && !el.hidden);
    await page.waitForTimeout(90);
    const mid = await page.evaluate(() => ({ x: new DOMMatrix(getComputedStyle(document.getElementById("drawer")).transform).m41, dim: Number(getComputedStyle(document.getElementById("scrim")).opacity) }));
    await shot("3-drawer-mid-slide");
    await page.waitForTimeout(400);
    const settled = await page.evaluate(() => ({ transform: getComputedStyle(document.getElementById("drawer")).transform, dim: getComputedStyle(document.getElementById("scrim")).opacity }));
    await shot("4-drawer-open");
    check(opened && mid.x > 0 && mid.dim > 0 && mid.dim < 1, `mid-slide: still moving in (${Math.round(mid.x)} px to go) while the page dims (${mid.dim.toFixed(2)})`);
    check(settled.transform === "none" && settled.dim === "1", `then in place (${settled.transform}, dim ${settled.dim})`);
    check((await tableLeft()) === leftBefore, "the table behind doesn't move sideways");
    await page.keyboard.press("Escape");
    const leaving = await page.$eval("#drawer", (el) => ({ inert: el.inert, hidden: el.hidden, open: el.classList.contains("is-open") }));
    await page.waitForTimeout(60);
    await shot("5-drawer-mid-close");
    check(leaving.inert && !leaving.hidden && !leaving.open, `Escape: it slides out, already out of reach for keyboard and screen readers (${JSON.stringify(leaving)})`);
    check(await page.waitForSelector("#drawer", { state: "hidden", timeout: 1000 }).then(() => true, () => false), "and is hidden once the slide is over");

    // Send, then Hafiz pays: the tag pops, the Paid card counts up, cha-ching.
    await visible(page, "[data-send-invoices]").click();
    await page.waitForFunction(() => /\d+ of \d+ sent/.test(document.getElementById("send-message").textContent), null, { timeout: 15000 });
    check((await sound(page)).contexts === 0, "no sound before anyone has paid");
    await pays(page, run, "Hafiz");
    const pop = await page.locator(ROWS, { hasText: "Hafiz" }).locator(".badge").evaluate((el) => ({ cls: el.className, anim: getComputedStyle(el).animationName }));
    await page.waitForTimeout(80);
    await shot("6-paid-mid");
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => window.__paidFrames);
    const heard = await sound(page);
    check(pop.cls.includes("is-new-paid") && pop.anim === "paid-pop", `Hafiz's Paid tag pops (${JSON.stringify(pop)})`);
    check(frames.at(-1) === "RM 45.00" && frames.some((f) => f !== "RM 0.00" && f !== "RM 45.00"), `the Paid card counts up to RM 45.00 (${frames.length} values, e.g. ${frames.slice(1, 3).join(", ")})`);
    check(heard.contexts === 1 && heard.notes === 6, `cha-ching: one soft two-note sound (${JSON.stringify(heard)})`);
    await shot("7-paid", true);

    // Mute: remembered in this browser; the count-up still runs, the sound doesn't.
    await page.click("#sound-toggle");
    check((await page.$eval("#sound-toggle", (el) => el.getAttribute("aria-pressed"))) === "false"
      && (await page.evaluate(() => localStorage.getItem("chatching-sound"))) === "off", "Mute: aria-pressed false, remembered as off");
    await pays(page, run, "Mei Ling");
    await page.waitForTimeout(500);
    check((await sound(page)).notes === 6 && (await page.evaluate(() => window.__paidFrames.at(-1))) === "RM 117.00", "muted: Mei Ling's payment counts up but makes no sound");
    await page.reload();
    await page.waitForSelector(ROWS);
    check((await page.$eval("#sound-toggle", (el) => el.getAttribute("aria-pressed"))) === "false", "after a reload the sound is still muted");
    await page.click("#sound-toggle");
    await page.waitForTimeout(100);
    check((await page.$eval("#sound-toggle", (el) => el.getAttribute("aria-pressed"))) === "true" && (await sound(page)).notes === 6, "turned back on: a short preview plays");

    // "(cash/bank)" on one line of its tag; the About line.
    await page.evaluate((id) => fetch(`/api/invoices/${encodeURIComponent(id)}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "CASH" }) }), await invoiceOf(page, "Lina"));
    await page.reload();
    await page.waitForSelector(ROWS);
    await goToBuyer(page, "Lina");
    const widths = size.name === "laptop" ? [1280, 1024] : size.name === "ipad" ? [820, 768] : [390];
    for (const width of widths) {
      await page.setViewportSize({ width, height: size.height });
      await page.waitForTimeout(400);
      const lines = await cashBankLines(page);
      check(lines === 1, `${width} px: "(cash/bank)" stays on one line of its tag (${lines} line${lines === 1 ? "" : "s"}, layout ${await page.$eval("#grid", (el) => el.dataset.layout)})`);
    }
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(400);
    const about = plain(await page.$eval("footer", (el) => el.innerText));
    check(about.startsWith("About this demo: it uses the PayPal sandbox only, so no real money moves. Test buyer logins are in the README."), `the About line: "${about.slice(0, 60)}..."`);

    // A11y sweep on the full table (paid, cash, sent and amber rows).
    await page.waitForTimeout(2500); // the green flash is over
    const small = await smallTargets(page);
    check(small.length === 0, `every tap target is at least 44 x 44 px${small.length ? `: ${small.join("; ")}` : ""}`);
    const low = await lowContrast(page);
    check(low.length === 0, `text contrast meets WCAG AA${low.length ? `: ${low.join("; ")}` : ""}`);
    if (size.name === "laptop") {
      check((await placeholderRatio(page, "#search")) >= 4.5, "the search placeholder is readable (4.5:1 or more)");
      // Tab from the search box into the table: the focused cell shows the 3 px blue ring, inside the cell.
      await page.focus("#search");
      for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement.matches(".ag-cell"))); i++) await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outline);
      check(/rgb\(58, 91, 199\) solid 3px/.test(ring), `a table cell reached with Tab shows the 3 px blue ring (${ring})`);
      await page.evaluate(() => document.activeElement.blur());
    }
    await shot("8-final", true);
    // The buyer page at this width, before and after Looks right.
    const link = (await stateNow(page)).texts.find((t) => t.buyer === "Aisyah").message.split(" ").at(-1);
    const buyerContext = await browser.newContext(contextOptions(size));
    const buyer = await buyerContext.newPage();
    watch(buyer, errors);
    await buyer.goto(link);
    await buyer.waitForSelector("#order-content:not([hidden])");
    await buyer.screenshot({ path: `${OUT}${size.width}-${size.name}-9-buyer.png`, fullPage: true });
    const buyerSmall = await smallTargets(buyer);
    const buyerLow = await lowContrast(buyer);
    check(buyerSmall.length === 0 && buyerLow.length === 0, `buyer page: tap targets and contrast${[...buyerSmall, ...buyerLow].length ? `: ${[...buyerSmall, ...buyerLow].join("; ")}` : ""}`);
    await buyer.click("#answer-ok");
    await buyer.waitForSelector("#answer-said:not([hidden])");
    await buyer.waitForTimeout(250);
    await buyer.screenshot({ path: `${OUT}${size.width}-${size.name}-10-buyer-confirmed.png`, fullPage: true });
    await buyerContext.close();

    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await context.close();
    run.server.closeAllConnections();
    run.server.close();
  }

  // ---- 2. Reduced motion: everything just changes, nothing moves, no sound ----
  console.log("\nReduced motion (1280 px)");
  {
    const run = await startServer(testVisitor({ rows: [] }).dir);
    const context = await browser.newContext(contextOptions(SIZES[0], { reducedMotion: "reduce" }));
    await context.addInitScript(spy);
    const page = await context.newPage();
    const errors = [];
    watch(page, errors);
    await page.goto(run.base);
    await page.waitForSelector(".ag-overlay");
    check(await page.$eval("#sound-toggle", (el) => el.hidden), "no mute toggle: there is no sound with reduced motion");
    await page.click("#load-demo");
    await page.waitForFunction(() => document.getElementById("chat").value.length > 100);
    await page.click("#read-orders");
    await page.waitForSelector(ROWS);
    check(!(await page.$eval("#grid", (el) => el.classList.contains("is-entering"))), "Read orders: the rows just appear");
    const csv = visible(page, "#export-csv");
    await csv.scrollIntoViewIfNeeded();
    const box = await csv.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    const pressed = await csv.evaluate((el) => getComputedStyle(el).transform);
    await page.mouse.up();
    check(pressed === "none", `a pressed button doesn't move (${pressed})`);
    await goToBuyer(page, "Lina");
    await page.locator(ROWS, { hasText: "Lina" }).locator(".chips").click();
    const drawer = await page.$eval("#drawer", (el) => ({ transform: getComputedStyle(el).transform, duration: getComputedStyle(el).transitionDuration }));
    check(drawer.transform === "none" && drawer.duration === "0s", `the drawer is simply there (${JSON.stringify(drawer)})`);
    await page.keyboard.press("Escape");
    check(await page.$eval("#drawer", (el) => el.hidden), "and simply gone on Escape");
    await visible(page, "[data-send-invoices]").click();
    await page.waitForFunction(() => /\d+ of \d+ sent/.test(document.getElementById("send-message").textContent), null, { timeout: 15000 });
    await pays(page, run, "Hafiz");
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => window.__paidFrames);
    const anim = await page.locator(ROWS, { hasText: "Hafiz" }).locator(".badge").evaluate((el) => getComputedStyle(el).animationName);
    check(frames.length > 0 && frames.every((f) => f === "RM 45.00"), `the Paid figure just changes to RM 45.00 (${frames.join(", ")})`);
    check(anim === "none" && (await sound(page)).contexts === 0, `no pop (${anim}) and no sound`);
    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await context.close();
    run.server.closeAllConnections();
    run.server.close();
  }

  // ---- 3. No sound before the seller has clicked anything on the page ----
  console.log("\nNo click yet (1280 px)");
  {
    const visitor = testVisitor();
    const run = await startServer(visitor.dir);
    const page = await visitorPage(browser, visitor, run.base, contextOptions(SIZES[0]));
    await page.addInitScript(spy);
    const errors = [];
    watch(page, errors);
    await page.goto(run.base);
    await page.waitForSelector(ROWS);
    await page.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // the tab comes back: the page sees the sent table
    await page.waitForTimeout(500);
    run.fake.pay(await invoiceOf(page, "Hafiz"));
    run.skip(11_000);
    await page.evaluate(() => fetch("/api/invoices/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => /RM\s45\.00/.test(document.querySelector("#stat-paid [data-figure]").textContent), null, { timeout: 5000 }).catch(() => {});
    await goToBuyer(page, "Hafiz");
    const status = plain(await page.locator(ROWS, { hasText: "Hafiz" }).locator(".badge").innerText());
    check(status === "Paid" && (await sound(page)).contexts === 0, `Hafiz turned Paid with no click on the page: no sound at all (${status}, ${JSON.stringify(await sound(page))})`);
    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.context().close();
    run.server.closeAllConnections();
    run.server.close();
  }

  // ---- 4. Waking up the server (Render's free tier sleeps; a deploy switches over) ----
  console.log("\nWaking up (1280 px)");
  {
    const visitor = testVisitor();
    const run = await startServer(visitor.dir);
    const expected = [/status of 503/, /net::ERR_FAILED/, /Failed to load resource/];
    // a) Two 503s, then the server answers.
    let page = await visitorPage(browser, visitor, run.base, contextOptions(SIZES[0]));
    let errors = [];
    watch(page, errors, expected);
    let refused = 0;
    await page.route("**/api/state", (route) => (refused < 2 ? (refused++, route.fulfill({ status: 503, contentType: "text/html", body: "<h1>Service Unavailable</h1>" })) : route.continue()));
    await page.goto(run.base);
    await page.waitForFunction(() => document.getElementById("next-text").textContent.startsWith("Waking up the server"), null, { timeout: 5000 }).catch(() => {});
    const waking = await page.evaluate(() => ({
      text: document.getElementById("next-text").textContent,
      send: [...document.querySelectorAll("[data-send-invoices]")].every((b) => b.disabled),
      counter: document.getElementById("ai-calls").hidden,
      dots: /…|\.\.\.(?! It)/.test(document.body.innerText.replace("Waking up the server...", "")),
      tryDemo: document.getElementById("try-demo").hidden,
    }));
    await page.screenshot({ path: `${OUT}1280-waking.png` });
    check(waking.text.startsWith("Waking up the server... It sleeps when nobody is using it") && waking.tryDemo, `a 503: "${waking.text.slice(0, 40)}..."`);
    check(waking.send && waking.counter && !waking.dots, `meanwhile no active Send button and no "..." counter (${JSON.stringify(waking)})`);
    await page.waitForSelector(ROWS, { timeout: 15000 }).catch(() => {});
    check((await page.$$(ROWS)).length > 0 && refused === 2 && !(await page.$eval("#ai-calls", (el) => el.hidden)), `then it loads by itself (after ${refused} refusals)`);
    check(!(await page.$eval("#next-text", (el) => el.textContent)).startsWith("Waking") && (await page.$eval("#error", (el) => el.hidden)), "and the waking words are gone");
    check(errors.length === 0, `no other console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.context().close();

    // b) No answer at all, ever: plain words after the tries (the page's clock is jumped ahead).
    page = await visitorPage(browser, visitor, run.base, contextOptions(SIZES[0]));
    errors = [];
    watch(page, errors, expected);
    await page.route("**/api/state", (route) => route.abort());
    await page.clock.install();
    await page.goto(run.base);
    await page.waitForFunction(() => document.getElementById("next-text").textContent.startsWith("Waking"), null, { timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 8 && (await page.$eval("#error", (el) => el.hidden)); i++) {
      await page.clock.fastForward(13_000);
      await page.waitForTimeout(150);
    }
    const gave = await page.evaluate(() => ({
      error: document.getElementById("error").hidden ? "" : document.getElementById("error").textContent,
      card: document.getElementById("next-step").hidden,
      send: [...document.querySelectorAll("[data-send-invoices]")].every((b) => b.disabled),
      counter: document.getElementById("ai-calls").hidden,
    }));
    await page.screenshot({ path: `${OUT}1280-no-server.png` });
    check(gave.error.startsWith("Error: Can't reach the server (no answer). Please wait a minute, then reload the page."), `no answer: "${gave.error.slice(0, 80)}..."`);
    check(gave.card && gave.send && gave.counter, `no buttons that need the server, no active Send, no counter (${JSON.stringify(gave)})`);
    check(errors.length === 0, `no other console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await page.context().close();

    // c) The buyer's page waits the same way.
    page = await visitorPage(browser, visitor, run.base, contextOptions(SIZES[2]));
    await page.goto(run.base);
    await page.waitForSelector(ROWS);
    await page.evaluate(() => fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    const link = (await stateNow(page)).texts.find((t) => t.buyer === "Lina").message.split(" ").at(-1);
    await page.context().close();
    const buyerContext = await browser.newContext(contextOptions(SIZES[2]));
    const buyer = await buyerContext.newPage();
    errors = [];
    watch(buyer, errors, expected);
    let buyerRefused = 0;
    await buyer.route("**/api/order/view", (route) => (buyerRefused < 1 ? (buyerRefused++, route.fulfill({ status: 503, contentType: "text/html", body: "busy" })) : route.continue()));
    await buyer.goto(link);
    await buyer.waitForFunction(() => document.getElementById("order-words").textContent.startsWith("Waking up the server"), null, { timeout: 5000 }).catch(() => {});
    const buyerWaking = await buyer.$eval("#order-words", (el) => el.textContent);
    await buyer.screenshot({ path: `${OUT}390-buyer-waking.png` });
    await buyer.waitForSelector("#order-content:not([hidden])", { timeout: 10000 }).catch(() => {});
    check(buyerWaking.startsWith("Waking up the server") && !(await buyer.$eval("#order-content", (el) => el.hidden)), `the buyer's page: "${buyerWaking.slice(0, 30)}...", then her order`);
    check(errors.length === 0, `no other console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    await buyerContext.close();
    run.server.closeAllConnections();
    run.server.close();
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: all polish checks passed.");
process.exit(failed ? 1 : 0);
