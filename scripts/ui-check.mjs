// The Step 2 browser check: opens the page at laptop, iPad and phone widths, takes screenshots,
// and fails on any console error. Then it edits Priya's row in the real table (item -> Classic
// brownies, qty -> 1), checks her row turns clear and the totals update, reloads, and checks the
// edit survived. Run: node scripts/ui-check.mjs (uses the installed Google Chrome, no download).
// It starts its own server on a free port with its own store file in tmp/, so your saved orders
// in data/runtime/ are never touched. (AG Grid 36 class names: body rows sit in .ag-grid-scrolling-container.) Screenshots go to tmp/screenshots/ (git-ignored).
import { mkdirSync, rmSync } from "node:fs";
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

async function open(viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  // Warnings count too: AG Grid reports misuse (e.g. warning #3) as a warning, not an error.
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(base);
  await page.waitForSelector(".ag-grid-scrolling-container > .ag-row");
  await page.waitForTimeout(500); // let the grid finish measuring the wrapped rows
  return { page, errors };
}

const headers = (page) => page.$$eval(".ag-header-cell-text", (els) => els.map((el) => el.textContent.trim()));
const pinnedText = (page) => page.$eval(".ag-grid-pinned-bottom-rows", (el) => el.innerText).catch(() => "");

try {
  for (const viewport of WIDTHS) {
    const { page, errors } = await open(viewport);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}.png`, fullPage: true });
    const cols = await headers(page);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`\n${viewport.width} px (${viewport.name}): columns = ${cols.join(", ")}`);
    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(pageWidth <= viewport.width, `no sideways page scroll (page is ${pageWidth} px wide)`);
    const step = await page.$eval(".steps li.current", (el) => el.innerText.replace(/\s+/g, " ").trim());
    check(step.endsWith("Review orders"), `guide shows the current step: "${step}"`);
    const cards = plain(await page.$eval(".summary", (el) => el.innerText));
    check(cards.includes("Orders 8") && cards.includes("Expected RM 387.00") && cards.includes("Paid RM 0.00") && cards.includes("Needs check 1"),
      `summary cards: "${cards}"`);
    check(await page.$eval("#stat-check", (el) => el.classList.contains("is-check")), "Needs check card is amber");
    const icons = await page.$$eval("svg.lucide", (els) => els.length);
    check(icons >= 15, `Lucide icons drawn (${icons})`);
    const ai = plain(await page.$eval("#ai-calls", (el) => el.innerText));
    check(ai.startsWith("AI calls left today:"), `header shows "${ai}"`);
    const headerTop = await page.evaluate(() => { scrollTo(0, 600); return document.querySelector(".topbar").getBoundingClientRect().top; });
    check(headerTop === 0, "header stays at the top when scrolling (sticky)");
    await page.evaluate(() => scrollTo(0, 0));
    const bar = plain(await page.$eval("#chat-bar", (el) => (el.hidden ? "" : el.innerText)));
    check(bar.startsWith("15 messages read") && bar.endsWith("Edit"), `chats folded into a slim bar: "${bar}"`);
    check(await page.$eval("#chats", (el) => el.hidden), "chat box hidden while folded");
    const hafiz1 = plain(await page.locator('[row-id="r2"] [col-id="buyer"]').innerText());
    const hafiz2 = plain(await page.locator('[row-id="r3"] [col-id="buyer"]').innerText());
    check(hafiz1 === "H Hafiz 2 items, RM 70.00" && hafiz2 === "", `buyer group: first row "${hafiz1}", second row "${hafiz2}"`);
    const setup = plain(await page.$eval("footer", (el) => el.innerText));
    check(setup.includes("PayPal keys: missing") && !(await page.$("#meta")), `setup details only in the footer: "${setup}"`);
    if (viewport.name === "phone") {
      check(cols.join() === "Buyer,Item,Total,Status", "phone shows only Buyer, Item, Total, Status");
      const bar = plain(await page.$eval("#phone-total", (el) => el.innerText));
      check(bar === "Total: 7 orders ready RM 387.00", `sticky bar: "${bar}"`);
      // The Check column is hidden on phones, so the words must sit under the item name.
      const priyaRow = page.locator(".ag-grid-scrolling-container > .ag-row", { has: page.locator('[col-id="buyer"]', { hasText: "Priya" }) });
      const item = plain(await priyaRow.locator('[col-id="itemId"]').innerText());
      check(item.includes("Check:") && item.includes("Same order as last week"), `Priya's item cell shows the Check words: "${item}"`);
      const lina = plain(await page.locator(".ag-grid-scrolling-container > .ag-row", { has: page.locator('[col-id="buyer"]', { hasText: "Lina" }) }).locator('[col-id="itemId"]').innerText());
      check(!lina.includes("Check:"), `a clear row has no Check words: "${lina}"`);
    } else if (viewport.name === "ipad") {
      check(cols.join() === "Buyer,Item,Qty,Date,Total,Status", "iPad: 6 columns, the Check words sit under the item");
      const priyaItem = plain(await page.locator(".ag-grid-scrolling-container > .ag-row", { has: page.locator('[col-id="buyer"]', { hasText: "Priya" }) }).locator('[col-id="itemId"]').innerText());
      check(priyaItem.includes("Check:"), `iPad: Priya's item cell shows the Check words: "${priyaItem}"`);
      const pinned = plain(await pinnedText(page));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 387.00"), `pinned totals row: "${pinned}"`);
    } else {
      check(cols.join() === "Buyer,Item,Qty,Date,Total,Status,Check", "laptop: all 7 columns shown");
      const pinned = plain(await pinnedText(page));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 387.00"), `pinned totals row: "${pinned}"`);
    }
    await page.close();
  }

  // The edit: Priya's row in the real table, at laptop width.
  console.log("\nEdit Priya: item -> Classic brownies, qty -> 1");
  const { page, errors } = await open(WIDTHS[0]);
  const priya = page.locator(".ag-grid-scrolling-container > .ag-row", { has: page.locator('[col-id="buyer"]', { hasText: "Priya" }) });
  check(await priya.evaluate((el) => el.classList.contains("row-unclear")), "before: Priya's row is amber (unclear)");
  await page.click("#chat-edit");
  check(!(await page.$eval("#chats", (el) => el.hidden)) && (await page.$eval("#chat", (el) => el.value.startsWith("[28/10 9:02 AM] Lina:"))),
    "Edit opens the chat box with the 15 messages that were read");
  await page.click("#chat-hide");
  check(await page.$eval("#chats", (el) => el.hidden), "Hide chats folds it again");
  console.log(`      before: Check = "${plain(await priya.locator('[col-id="check"]').innerText())}"`);

  await priya.locator('[col-id="itemId"]').click();
  await page.locator(".ag-cell-editor .ag-picker-field-wrapper").click(); // open the dropdown list
  const saveItem = page.waitForResponse((res) => res.url().includes("/api/orders/") && res.request().method() === "PUT");
  await page.locator(".ag-list-item", { hasText: "Classic brownies (box of 6)" }).click();
  console.log(`      PUT itemId -> ${(await saveItem).status()}`);

  await priya.locator('[col-id="qty"]').click();
  const saveQty = page.waitForResponse((res) => res.url().includes("/api/orders/") && res.request().method() === "PUT");
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  console.log(`      PUT qty -> ${(await saveQty).status()}`);
  await page.waitForTimeout(300); // let the grid redraw the row

  const afterEdit = async (label) => {
    const unclear = await priya.evaluate((el) => el.classList.contains("row-unclear"));
    const item = plain(await priya.locator('[col-id="itemId"]').innerText());
    const qty = plain(await priya.locator('[col-id="qty"]').innerText());
    const total = plain(await priya.locator('[col-id="lineTotal"]').innerText());
    // The Check column disappears once nothing needs checking; no cell means no Check text.
    const checkCell = priya.locator('[col-id="check"]');
    const checkText = (await checkCell.count()) ? plain(await checkCell.innerText()) : "";
    const pinned = plain(await pinnedText(page));
    console.log(`      ${label}: item "${item}", qty ${qty}, total ${total}, Check "${checkText}"; totals "${pinned}"`);
    check(!unclear && checkText === "", `${label}: Priya's row is clear (no amber, no Check text)`);
    check(item === "Classic brownies (box of 6)" && qty === "1" && total === "RM 18.00", `${label}: price from the server: RM 18.00`);
    check(pinned.includes("8 orders ready") && pinned.includes("RM 405.00"), `${label}: totals updated to 8 orders, RM 405.00`);
    const cards = plain(await page.$eval(".summary", (el) => el.innerText));
    check(cards.includes("Expected RM 405.00") && cards.includes("Needs check 0 All clear"), `${label}: summary cards updated: "${cards}"`);
    check(!(await page.$eval("#stat-check", (el) => el.classList.contains("is-check"))), `${label}: Needs check card is no longer amber`);
    const cols = (await headers(page)).join();
    check(cols === "Buyer,Item,Qty,Date,Total,Status", `${label}: Check column hidden once nothing needs checking (${cols})`);
    const priyaBuyer = plain(await priya.locator('[col-id="buyer"]').innerText());
    check(priyaBuyer === "P Priya 1 item, RM 18.00", `${label}: Priya's subtotal: "${priyaBuyer}"`);
  };
  await afterEdit("after edit");
  await page.evaluate(() => scrollTo(0, 0)); // the edit scrolled the page; the sticky header would sit mid-shot
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}1280-laptop-after-edit.png`, fullPage: true });

  await page.reload();
  await page.waitForSelector(".ag-grid-scrolling-container > .ag-row");
  await afterEdit("after reload");
  check(errors.length === 0, `no console errors or warnings during the edit${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\nScreenshots in ${OUT}`);
console.log(failed ? `FAIL: ${failed} check(s) failed.` : "PASS: all browser checks passed.");
process.exitCode = failed ? 1 : 0;
