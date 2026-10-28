// The browser check (design round 3 + tools): it CLICKS the Needs check card, TYPES in the search box and
// CLICKS Export CSV (and reads the file), so none of them can pass while broken in the browser.
// The browser check (design round 3): opens the page at laptop, iPad and phone widths, takes screenshots,
// and fails on any console error or warning. It checks one row per buyer, 6 buyers per page, the hero
// card and the icon circles, then fixes Priya IN THE DRAWER (item -> Classic brownies, qty -> 1), checks
// a refused change (qty 0) shows an error and is undone, reloads, and checks the fix survived.
// Run: npm run ui-check (uses the installed Google Chrome, no download).
// It starts its own server on a free port with its own store file in tmp/, so your saved orders
// in data/runtime/ are never touched. Screenshots go to tmp/screenshots/ (git-ignored).
// (AG Grid 36 class names: body rows sit in .ag-grid-scrolling-container.)
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const OUT = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "ipad", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = createApp(loadConfig({}), { log: () => {}, storeFile: `${OUT}orders.json` }).listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => text.replace(/\s+/g, " ").trim(); // Intl uses a no-break space after "RM"

// Priya's order row id, from the server (her buyer row in the table uses the same id).
const state = await (await fetch(`${base}/api/state`)).json();
const PRIYA = state.groups.find((group) => group.buyer === "Priya").rowIds[0];

async function open(viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  // Warnings count too: AG Grid reports misuse as a warning, not an error.
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(base);
  await page.waitForSelector(ROWS);
  await page.waitForTimeout(500); // let the grid finish measuring the rows
  return { page, errors };
}

const headers = (page) => page.$$eval(".ag-header-cell-text", (els) => els.map((el) => el.textContent.trim()).filter(Boolean));
const bodyRows = (page) => page.$$eval(ROWS, (els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
const pinnedText = (page) => page.$eval(".ag-grid-pinned-bottom-rows", (el) => el.innerText).catch(() => "");
const rowOf = (page, buyer) => page.locator(ROWS, { hasText: buyer });
const isUnclear = (locator) => locator.evaluate((el) => el.classList.contains("row-unclear"));
const putReply = (page) => page.waitForResponse((res) => res.url().includes("/api/orders/") && res.request().method() === "PUT");

// Secondary grey (#6E6E73) against a colour, as a WCAG contrast ratio (computed in the browser).
const CONTRAST = `(rgb) => {
  const lum = (r, g, b) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [r, g, b] = rgb.match(/\\d+/g).map(Number);
  const a = lum(110, 110, 115), c = lum(r, g, b);
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
}`;

async function exportedCsv(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-csv")]);
  return { name: download.suggestedFilename(), text: readFileSync(await download.path(), "utf8") };
}

// The page a buyer is on (the AI decides the order of buyers, so never assume it): go there.
async function goToBuyer(page, buyer) {
  for (const n of [1, 2]) {
    await goToPage(page, n);
    if (await page.locator(ROWS, { hasText: buyer }).count()) return n;
  }
  throw new Error(`${buyer} is on neither page`);
}

async function goToPage(page, n) {
  const target = `Page ${n} of 2`;
  for (let i = 0; i < 3 && plain(await page.$eval("#page-text", (el) => el.textContent)) !== target; i++) {
    await page.click(n === 2 ? "#page-next" : "#page-prev");
    await page.waitForTimeout(300);
  }
}

try {
  for (const viewport of WIDTHS) {
    const { page, errors } = await open(viewport);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}.png`, fullPage: true });
    const cols = await headers(page);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`\n${viewport.width} px (${viewport.name}): columns = ${cols.join(", ") || "(phone cards, no header)"}`);
    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(pageWidth <= viewport.width, `no sideways page scroll (page is ${pageWidth} px wide)`);

    const step = await page.$eval(".steps li.current", (el) => el.innerText.replace(/\s+/g, " ").trim());
    check(step.endsWith("Review orders"), `guide shows the current step: "${step}"`);
    const cards = plain(await page.$eval(".summary", (el) => el.innerText));
    check(cards.includes("Expected RM 387.00") && cards.includes("Orders 8") && cards.includes("Paid RM 0.00") && cards.includes("Needs check 1"),
      `summary cards: "${cards}"`);
    const hero = await page.$eval("#stat-expected", (el) => getComputedStyle(el).backgroundImage);
    check(hero.includes("gradient") && hero.includes("38, 48, 122"), "Expected is the deep indigo hero card (gradient)");
    check(await page.$eval("#stat-check", (el) => el.classList.contains("is-check")), "Needs check card is amber");
    const circles = await page.$$eval(".stat .icon-circle svg.lucide, .steps .icon-circle svg.lucide", (els) => els.length);
    check(circles === 7, `icons in soft circles on the 4 cards and 3 steps (${circles})`);
    const ai = plain(await page.$eval("#ai-calls", (el) => el.innerText));
    check(ai.startsWith("AI calls left today:"), `header shows "${ai}"`);
    const headerTop = await page.evaluate(() => { scrollTo(0, 600); return document.querySelector(".topbar").getBoundingClientRect().top; });
    check(headerTop === 0, "header stays at the top when scrolling (sticky)");
    await page.evaluate(() => scrollTo(0, 0));
    const bar = plain(await page.$eval("#chat-bar", (el) => (el.hidden ? "" : el.innerText)));
    check(bar.startsWith("15 messages read") && bar.endsWith("Edit"), `chats folded into a slim bar: "${bar}"`);
    const setup = plain(await page.$eval("footer", (el) => el.innerText));
    check(setup.includes("PayPal keys: missing"), `setup details in the quiet footer: "${setup}"`);

    // One row per buyer, 6 per page; a buyer is never split.
    const page1 = await bodyRows(page);
    check(page1.length === 6, `page 1 shows 6 buyers (${page1.length})`);
    check(plain(await page.$eval("#page-text", (el) => el.textContent)) === "Page 1 of 2", "page arrows say Page 1 of 2");
    const hafiz = page1.filter((text) => text.includes("Hafiz"));
    check(hafiz.length === 1 && hafiz[0].includes("1 × Burnt cheesecake 6-inch") && hafiz[0].includes("1 × Choc chip cookies") && hafiz[0].includes("RM 70.00"),
      `Hafiz is ONE row with both item chips and his total: "${hafiz[0]}"`);
    const chipIcons = await rowOf(page, "Hafiz").locator(".chip svg.lucide").count();
    check(chipIcons === 2, `food icons on Hafiz's item chips (${chipIcons})`);

    // Background shapes: 3 soft blurred shapes, never darker than the page (grey text keeps >= 4.66:1).
    const shapes = await page.$$eval(".backdrop span", (els, contrast) => els.map((el) => {
      const style = getComputedStyle(el);
      return { blur: style.filter.includes("blur"), ratio: new Function(`return ${contrast}`)()(style.backgroundColor) };
    }), CONTRAST);
    check(shapes.length === 3 && shapes.every((s) => s.blur && s.ratio >= 4.66),
      `background: 3 blurred shapes; grey text contrast on them ${shapes.map((s) => s.ratio.toFixed(2)).join(", ")} (>= 4.66)`);

    // CLICK the Needs check card: only Priya; click again: everyone.
    const card = page.locator("#stat-check");
    check(await card.evaluate((el) => el.tagName === "BUTTON" && !el.disabled), "Needs check card is a button");
    await card.click();
    await page.waitForTimeout(300);
    let shown = await bodyRows(page);
    const note = plain(await page.$eval("#filter-note", (el) => (el.hidden ? "" : el.innerText)));
    check(shown.length === 1 && shown[0].includes("Priya") && (await card.getAttribute("aria-pressed")) === "true" && note.startsWith("Showing 1 buyer that needs a check"),
      `clicking Needs check shows only Priya (${shown.length} row; note "${note}")`);
    check(await page.$eval("#pager", (el) => el.hidden), "one page of results: the page arrows hide");
    await card.click();
    await page.waitForTimeout(300);
    shown = await bodyRows(page);
    check(shown.length === 6 && (await card.getAttribute("aria-pressed")) === "false" && (await page.$eval("#filter-note", (el) => el.hidden)),
      `clicking it again shows all buyers again (${shown.length} on page 1)`);

    // TYPE in the search box.
    const search = async (text) => {
      await page.fill("#search", text);
      await page.waitForTimeout(300);
      return (await bodyRows(page)).map((row) => row.split(" ").slice(1, 3).join(" "));
    };
    let found = await search("cookies");
    check(found.length === 2 && found.join().includes("Hafiz") && found.join().includes("Mei Ling"), `search "cookies" finds Hafiz and Mei Ling (${found.join(" | ")})`);
    found = await search("priya");
    check(found.length === 1 && found[0].includes("Priya"), `search "priya" finds Priya, even on page 2 (${found.join(" | ")})`);
    found = await search("pizza");
    const empty = plain(await page.$eval(".ag-overlay", (el) => el.innerText).catch(() => ""));
    check(found.length === 0 && empty.includes("No buyers match"), `search "pizza" finds nobody and says so: "${empty}"`);
    found = await search("");
    check(found.length === 6, "clearing the search shows 6 buyers again");

    // CLICK Export CSV and read the file.
    if (viewport.name !== "ipad") {
      const { name, text } = await exportedCsv(page);
      const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
      const hafizLine = lines.find((line) => line.includes("Hafiz")) ?? "";
      check(name === "chatching-orders-2026-10-28.csv", `Export CSV downloads ${name}`);
      check(text.startsWith("\uFEFF"), "the CSV starts with a byte-order mark (Excel reads it as UTF-8)");
      check(lines[0] === '"Buyer","Items","Date","Total (MYR)","Status"', `CSV header: ${lines[0]}`);
      check(lines.length === 10, `CSV has all 9 buyers, not just one page (${lines.length - 1} rows)`);
      check(hafizLine.includes("1 × Burnt cheesecake 6-inch; 1 × Choc chip cookies (jar)") && hafizLine.includes('"70.00"'), `CSV Hafiz row: ${hafizLine}`);
    }

    if (viewport.name === "phone") {
      const headerHeight = await page.$eval(".ag-header", (el) => el.getBoundingClientRect().height);
      check(headerHeight <= 1 && (await page.$$(".card-row")).length === 6, `phone: buyers are stacked cards, no table header (header ${headerHeight} px)`);
      const sticky = plain(await page.$eval("#phone-sum", (el) => el.innerText));
      check(sticky === "Total: 7 orders ready RM 387.00", `sticky bar: "${sticky}"`);
    } else {
      const expected = viewport.name === "ipad" ? "Buyer,Items,Total,Status" : "Buyer,Items,Date,Total,Status";
      check(cols.join() === expected, `columns: ${cols.join(", ")}`);
      if (viewport.name === "ipad") {
        const lina = plain(await rowOf(page, "Lina").locator('[col-id="buyer"]').innerText());
        check(lina === "L Lina 1 item, Sat 31 Oct", `iPad: the date sits under the name: "${lina}"`);
      }
      const pinned = plain(await pinnedText(page));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 387.00"), `pinned totals row: "${pinned}"`);
    }

    await goToPage(page, 2);
    const page2 = await bodyRows(page);
    check(page2.length === 3 && plain(await page.$eval("#page-text", (el) => el.textContent)) === "Page 2 of 2", `page 2 shows the other 3 buyers (${page2.length})`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-page2.png`, fullPage: true });
    const priyaPage = await goToBuyer(page, "Priya");
    const priya = rowOf(page, "Priya");
    check(await isUnclear(priya), `Priya's row is amber (unclear), on page ${priyaPage}`);
    const priyaText = plain(await priya.innerText());
    // The demo is Gemini's real reply (Step 3b), so the reason is in the AI's own words.
    check(priyaText.includes("Check:") && priyaText.includes("Cannot determine items"), `Priya's row says why: "${priyaText}"`);

    if (viewport.name === "phone") {
      await priya.click();
      await page.waitForSelector("#drawer.is-open");
      await page.waitForTimeout(400); // let the drawer finish sliding in before the screenshot
      const drawerWidth = await page.$eval("#drawer", (el) => Math.round(el.getBoundingClientRect().width));
      check(drawerWidth === viewport.width, `phone: the drawer is full screen (${drawerWidth} px)`);
      await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-drawer.png` });
      await page.keyboard.press("Escape");
      check(await page.$eval("#drawer", (el) => el.hidden), "Escape closes the drawer");
    }
    await page.close();
  }

  // The fix, in the drawer, at laptop width.
  console.log("\nFix Priya in the drawer: item -> Classic brownies, qty -> 1");
  const { page, errors } = await open(WIDTHS[0]);
  await page.click("#stat-check"); // only the buyers that need a check
  await page.waitForTimeout(300);
  const priya = rowOf(page, "Priya");
  await priya.click();
  await page.waitForSelector("#drawer.is-open");
  await page.waitForTimeout(400);
  check(plain(await page.$eval("#drawer-title", (el) => el.textContent)) === "Priya", "tapping Priya's row opens her drawer");
  await page.screenshot({ path: `${OUT}1280-laptop-drawer.png` });

  let reply = putReply(page);
  await page.selectOption(`#edit-${PRIYA}-itemId`, "classic_brownies");
  console.log(`      PUT itemId -> ${(await reply).status()}`);
  await page.waitForTimeout(200);
  const midCheck = plain(await page.$eval("#drawer-body", (el) => el.innerText));
  check(midCheck.includes("Check: Quantity missing."), "after the item: the drawer still says the quantity is missing");

  reply = putReply(page);
  await page.fill(`#edit-${PRIYA}-qty`, "1");
  await page.keyboard.press("Tab"); // a number box saves when you leave it
  console.log(`      PUT qty -> ${(await reply).status()}`);
  await page.waitForTimeout(200);
  const sub = plain(await page.$eval("#drawer-sub", (el) => el.textContent));
  check(sub === "1 item, RM 18.00 in total" && !(await page.$("#drawer-body .check-text")), `drawer: Priya is clear: "${sub}"`);

  // A refused change: qty 0 -> the drawer says why, sends nothing, and the box goes back to 1.
  let puts = 0;
  const countPuts = (req) => req.method() === "PUT" && puts++;
  page.on("request", countPuts);
  await page.fill(`#edit-${PRIYA}-qty`, "0");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  page.off("request", countPuts);
  check(puts === 0, "qty 0 is stopped in the drawer: no request sent");
  const refused = plain(await page.$eval("#drawer-error", (el) => (el.hidden ? "" : el.textContent)));
  check(refused.startsWith("Error: That change was not saved") && refused.includes("1 to 99"), `a refused change is explained: "${refused}"`);
  check((await page.inputValue(`#edit-${PRIYA}-qty`)) === "1", "and the quantity goes back to 1");
  await page.keyboard.press("Escape");

  const afterFix = async (label) => {
    await goToBuyer(page, "Priya");
    const row = rowOf(page, "Priya");
    const text = plain(await row.innerText());
    const cards = plain(await page.$eval(".summary", (el) => el.innerText));
    const pinned = plain(await pinnedText(page));
    console.log(`      ${label}: row "${text}"; totals "${pinned}"`);
    check(!(await isUnclear(row)) && !text.includes("Check:"), `${label}: Priya's row is clear (no amber, no Check words)`);
    check(text.includes("1 × Classic brownies") && text.includes("RM 18.00"), `${label}: her chip and total come from the server (RM 18.00)`);
    check(pinned.includes("8 orders ready") && pinned.includes("RM 405.00"), `${label}: totals updated to 8 orders, RM 405.00`);
    check(cards.includes("Expected RM 405.00") && cards.includes("Needs check 0"), `${label}: summary cards updated`);
    check(!(await page.$eval("#stat-check", (el) => el.classList.contains("is-check"))), `${label}: Needs check card is no longer amber`);
    check(await page.$eval("#stat-check", (el) => el.disabled && el.getAttribute("aria-pressed") === "false" && document.getElementById("filter-note").hidden),
      `${label}: nothing to check, so the filter switched itself off and the card is not clickable`);
  };
  await afterFix("after the fix");
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}1280-laptop-after-fix.png`, fullPage: true });

  await page.reload();
  await page.waitForSelector(ROWS);
  await page.waitForTimeout(400);
  await afterFix("after reload");
  check(errors.length === 0, `no console errors or warnings during the fix${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: all browser checks passed.");
process.exitCode = failed ? 1 : 0;
