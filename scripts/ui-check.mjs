// The browser check (design round 3 + tools): it CLICKS the Needs check card, TYPES in the search box and
// CLICKS Export CSV (and reads the file), so none of them can pass while broken in the browser.
// The browser check (design round 3): opens the page at laptop, iPad and phone widths, takes screenshots,
// and fails on any console error or warning. It checks one row per buyer, 6 buyers per page, the hero
// card and the icon circles, then fixes Priya IN THE DRAWER (item -> Classic brownies, qty -> 1), checks
// a refused change (qty 0) shows an error and is undone, clicks "Keep menu price" for Jun Wei (Step 7a),
// reloads, and checks both fixes survived.
// Run: npm run ui-check (uses the installed Google Chrome, no download).
// It starts its own server on a free port with its own test visitor (the demo table) in a temporary
// folder, so your saved orders in data/runtime/ are never touched. Screenshots go to tmp/screenshots/ (git-ignored).
// (AG Grid 36 class names: body rows sit in .ag-grid-scrolling-container.)
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { testVisitor, visitorPage } from "./test-visitor.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots/", import.meta.url));
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "ipad", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const visitor = testVisitor();
const server = createApp(loadConfig({}), { log: () => {}, visitorsDir: visitor.dir }).listen(0);
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
const state = await (await visitor.fetch(`${base}/api/state`)).json();
const PRIYA = state.groups.find((group) => group.buyer === "Priya").rowIds[0];

async function open(viewport, url = base, who = visitor) {
  const page = await visitorPage(browser, who, url, { viewport });
  const errors = [];
  // Warnings count too: AG Grid reports misuse as a warning, not an error.
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(url);
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
    check(cards.includes("Expected RM 366.00") && cards.includes("Orders 9") && cards.includes("Paid RM 0.00") && cards.includes("Needs check 2"),
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
    check(bar.startsWith("18 messages read") && bar.endsWith("Edit"), `chats folded into a slim bar: "${bar}"`);
    const setup = plain(await page.$eval("footer", (el) => el.innerText));
    check(setup.includes("PayPal keys: missing"), `setup details in the quiet footer: "${setup}"`);

    // One row per buyer, 6 per page; a buyer is never split.
    const page1 = await bodyRows(page);
    check(page1.length === 6, `page 1 shows 6 buyers (${page1.length})`);
    check(plain(await page.$eval("#page-text", (el) => el.textContent)) === "Page 1 of 2", "page arrows say Page 1 of 2");
    const meiLing = page1.filter((text) => text.includes("Mei Ling"));
    check(meiLing.length === 1 && meiLing[0].includes("1 × Cheese brownies") && meiLing[0].includes("2 × Choc chip cookies") && meiLing[0].includes("RM 72.00"),
      `Mei Ling is ONE row with both item chips and her total: "${meiLing[0]}"`);
    const chipIcons = await rowOf(page, "Mei Ling").locator(".chip svg.lucide").count();
    check(chipIcons === 2, `food icons on Mei Ling's item chips (${chipIcons})`);

    // Background shapes: 3 soft blurred shapes, never darker than the page (grey text keeps >= 4.66:1).
    const shapes = await page.$$eval(".backdrop span", (els, contrast) => els.map((el) => {
      const style = getComputedStyle(el);
      return { blur: style.filter.includes("blur"), ratio: new Function(`return ${contrast}`)()(style.backgroundColor) };
    }), CONTRAST);
    check(shapes.length === 3 && shapes.every((s) => s.blur && s.ratio >= 4.66),
      `background: 3 blurred shapes; grey text contrast on them ${shapes.map((s) => s.ratio.toFixed(2)).join(", ")} (>= 4.66)`);

    // CLICK the Needs check card: only Priya and Jun Wei; click again: everyone.
    const card = page.locator("#stat-check");
    check(await card.evaluate((el) => el.tagName === "BUTTON" && !el.disabled), "Needs check card is a button");
    await card.click();
    await page.waitForTimeout(300);
    let shown = await bodyRows(page);
    const note = plain(await page.$eval("#filter-note", (el) => (el.hidden ? "" : el.innerText)));
    check(shown.length === 2 && shown[0].includes("Priya") && shown[1].includes("Jun Wei") && (await card.getAttribute("aria-pressed")) === "true" && note.startsWith("Showing 2 buyers that need a check"),
      `clicking Needs check shows only Priya and Jun Wei (${shown.length} rows; note "${note}")`);
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
    check(found.length === 1 && found.join().includes("Mei Ling"), `search "cookies" finds only Mei Ling: Hafiz cancelled his (${found.join(" | ")})`);
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
      const meiLine = lines.find((line) => line.includes("Mei Ling")) ?? "";
      check(name === "chatching-orders-2026-10-28.csv", `Export CSV downloads ${name}`);
      check(text.startsWith("\uFEFF"), "the CSV starts with a byte-order mark (Excel reads it as UTF-8)");
      check(lines[0] === '"Buyer","Items","Date","Total (MYR)","Status"', `CSV header: ${lines[0]}`);
      check(lines.length === 11, `CSV has all 10 buyers, not just one page (${lines.length - 1} rows)`);
      check(meiLine.includes("1 × Cheese brownies (box of 6); 2 × Choc chip cookies (jar)") && meiLine.includes('"72.00"'), `CSV Mei Ling row: ${meiLine}`);
      check(lines.slice(1).every((line) => !/^"?[=+\-@\t\r]/.test(line)), "no CSV row starts with a formula character");
    }

    if (viewport.name === "phone") {
      const headerHeight = await page.$eval(".ag-header", (el) => el.getBoundingClientRect().height);
      check(headerHeight <= 1 && (await page.$$(".card-row")).length === 6, `phone: buyers are stacked cards, no table header (header ${headerHeight} px)`);
      const sticky = plain(await page.$eval("#phone-sum", (el) => el.innerText));
      check(sticky === "Total: 7 orders ready RM 366.00", `sticky bar: "${sticky}"`);
    } else {
      const expected = viewport.name === "ipad" ? "Buyer,Items,Total,Status" : "Buyer,Items,Date,Total,Status";
      check(cols.join() === expected, `columns: ${cols.join(", ")}`);
      if (viewport.name === "ipad") {
        const lina = plain(await rowOf(page, "Lina").locator('[col-id="buyer"]').innerText());
        check(lina === "L Lina 1 item, Sat 31 Oct", `iPad: the date sits under the name: "${lina}"`);
      }
      const pinned = plain(await pinnedText(page));
      check(pinned.includes("7 orders ready") && pinned.includes("RM 366.00"), `pinned totals row: "${pinned}"`);
    }

    await goToPage(page, 2);
    const page2 = await bodyRows(page);
    check(page2.length === 4 && plain(await page.$eval("#page-text", (el) => el.textContent)) === "Page 2 of 2", `page 2 shows the other 4 buyers (${page2.length})`);
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-page2.png`, fullPage: true });
    const priyaPage = await goToBuyer(page, "Priya");
    const priya = rowOf(page, "Priya");
    check(await isUnclear(priya), `Priya's row is amber (unclear), on page ${priyaPage}`);
    const priyaText = plain(await priya.innerText());
    // The demo is Gemini's real reply (Step 7), so the reason is in the AI's own words.
    check(priyaText.includes("Check:") && priyaText.includes("Which brownies: classic or cheese?"), `Priya's row says why: "${priyaText}"`);
    const junWei = rowOf(page, "Jun Wei");
    await goToBuyer(page, "Jun Wei");
    const junText = plain(await junWei.innerText());
    check(await isUnclear(junWei) && junText.includes("Check: buyer mentioned RM 15.00, menu says RM 18.00."), `Jun Wei's wrong price is amber: "${junText}"`);
    await goToBuyer(page, "Priya");

    // Step 7: the buyer panel. Arif's drawer shows the AI's note and his 2 messages with the parts marked.
    await goToBuyer(page, "Arif");
    await rowOf(page, "Arif").click();
    await page.waitForSelector("#drawer.is-open .chat-card .chat-msg");
    await page.waitForTimeout(400);
    const chat = await page.$eval("#drawer .chat-card", (card) => ({
      title: card.querySelector(".edit-title").innerText.trim(),
      note: card.querySelector(".ai-note")?.innerText.trim() ?? "",
      messages: [...card.querySelectorAll(".chat-msg")].map((li) => li.innerText.replace(/\s+/g, " ").trim()),
      marks: [...card.querySelectorAll("mark.hl")].map((m) => `${m.className.replace("hl hl-", "")}:${m.textContent}`),
      first: card.parentElement.firstElementChild === card,
    }));
    check(chat.first && chat.title === "What Arif wrote" && chat.note === "", `the drawer starts with what Arif wrote (Gemini wrote no note for him: "${chat.note}")`);
    check(chat.messages.length === 2 && chat.messages[0].startsWith("Message 6, Wed 28 Oct, 10:30") && chat.messages[1].includes("will pick up tomorrow afternoon"),
      `his 2 messages, with their time: ${chat.messages.join(" | ")}`);
    check(["qty:2 packs", "fulfilment:pick up", "day:tomorrow"].every((m) => chat.marks.includes(m)), `the parts that mattered are marked: ${chat.marks.join(", ")}`);
    const markStyle = await page.$eval("#drawer mark.hl", (m) => getComputedStyle(m).backgroundColor);
    check(markStyle === "rgb(243, 236, 225)", `marks use the neutral warm tint, not blue/green (${markStyle})`);
    check(!(await page.$("#drawer .qr-card")), "no QR card before the invoice is sent");
    const drawerFits = await page.$eval("#drawer", (el) => el.scrollWidth <= el.clientWidth);
    check(drawerFits, "the messages fit the drawer (no sideways scroll)");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-panel-arif.png` });
    await page.keyboard.press("Escape");
    // Lina: the AI's own note, as plain text.
    await goToBuyer(page, "Lina");
    await rowOf(page, "Lina").click();
    await page.waitForSelector("#drawer.is-open .chat-card .chat-msg");
    await page.waitForTimeout(400); // let the drawer finish sliding in before the screenshot
    const linaNote = plain(await page.$eval("#drawer .ai-note", (el) => el.innerText).catch(() => ""));
    check(linaNote === "AI note: Changed classic brownies quantity from 2 to 3 boxes in message 4.", `Lina's drawer shows the AI's note: "${linaNote}"`);
    check((await page.$$eval("#drawer .chat-msg", (els) => els.length)) === 3, "and her 3 messages (order, change, payment-link request)");
    await page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-panel-lina.png` });
    await page.keyboard.press("Escape");
    // Jun Wei's wrong price is marked amber in his own message.
    await goToBuyer(page, "Jun Wei");
    await rowOf(page, "Jun Wei").click();
    await page.waitForSelector("#drawer.is-open .chat-card .chat-msg");
    const junMark = await page.$eval("#drawer mark.hl-price-check", (m) => ({ text: m.textContent, bg: getComputedStyle(m).backgroundColor })).catch(() => null);
    check(junMark?.text === "RM15" && junMark.bg === "rgb(252, 239, 214)", `Jun Wei's "RM15" is marked amber in his message (${JSON.stringify(junMark)})`);
    await page.keyboard.press("Escape");
    await goToBuyer(page, "Priya");

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

  // Nothing cut off (Step 10 + the table-width fix): with the chats folded AND open, every column fits the
  // table (the arrow column was scrolled out of sight at 1280 px with the chats open), every chip and status
  // tag stays inside its own cell ("1 × Burnt cheesecake 6-inch" ran into the Date column), no cell clips its
  // text, and every row shows its blue arrow (phone cards have none). 1024 px is the tightest laptop case.
  const cutOff = (page) => page.evaluate((rowsSelector) => {
    const grid = document.getElementById("grid").getBoundingClientRect();
    const name = (el) => el.closest(".ag-cell, .ag-header-cell")?.getAttribute("col-id") ?? "?";
    const problems = [];
    for (const cell of document.querySelectorAll(`#grid .ag-header-cell, ${rowsSelector} .ag-cell, #grid .ag-floating-bottom .ag-cell, #grid .ag-grid-pinned-bottom-rows .ag-cell`)) {
      const box = cell.getBoundingClientRect();
      if (!box.width) continue;
      if (box.right > grid.right + 0.5 || box.left < grid.left - 0.5) problems.push(`column ${name(cell)} is outside the table (${Math.round(box.right - grid.right)} px)`);
      if (cell.scrollWidth > cell.clientWidth + 1) problems.push(`column ${name(cell)} clips its text "${cell.innerText.trim().slice(0, 30)}"`);
    }
    for (const part of document.querySelectorAll(`${rowsSelector} .chip, ${rowsSelector} .badge`)) {
      const over = part.getBoundingClientRect().right - part.closest(".ag-cell").getBoundingClientRect().right;
      if (over > 0.5) problems.push(`"${part.textContent}" runs ${Math.round(over)} px out of its column`);
    }
    // The words must stay inside the tag too ("Paid (cash/bank)" ran out of its green pill at 1280 px: the
    // pill fitted the column, its text didn't). The demo rows don't have the long statuses, so try them all.
    for (const badge of document.querySelectorAll(`${rowsSelector} .badge`)) {
      const words = badge.lastChild;
      const shown = words.data;
      for (const text of ["Paid (cash/bank)", "Cancelled/Refunded"]) {
        words.data = text;
        const range = document.createRange();
        range.selectNodeContents(words);
        const over = range.getBoundingClientRect().right - badge.getBoundingClientRect().right;
        if (over > -1) problems.push(`"${text}" runs out of its status tag (${Math.round(over)} px)`);
      }
      words.data = shown;
    }
    const cards = !!document.querySelector(`${rowsSelector} .card-row`);
    if (!cards) {
      for (const row of document.querySelectorAll(rowsSelector)) {
        const cue = row.querySelector(".open-cue")?.getBoundingClientRect();
        if (!cue || cue.right > grid.right + 0.5 || !cue.width) problems.push(`no visible arrow on "${row.innerText.trim().split("\n")[0]}"`);
      }
    }
    return { problems: [...new Set(problems)], layout: cards ? "cards" : document.querySelector('#grid .ag-header-cell[col-id="date"]') ? "with Date column" : "Date under the name" };
  }, ROWS);
  for (const viewport of [WIDTHS[0], { name: "laptop-small", width: 1024, height: 800 }, { name: "tablet", width: 768, height: 1024 }, WIDTHS[2]]) {
    const { page: fitPage, errors: fitErrors } = await open(viewport);
    console.log(`\nNothing cut off at ${viewport.width} px`);
    for (const chats of ["folded", "open"]) {
      if (chats === "open") {
        await fitPage.click("#chat-edit");
        await fitPage.waitForTimeout(500);
      }
      for (const n of [1, 2]) {
        await goToPage(fitPage, n);
        const { problems, layout } = await cutOff(fitPage);
        check(problems.length === 0, `chats ${chats}, page ${n} (${layout}): the table fits and nothing is cut off${problems.length ? `: ${problems.join("; ")}` : ""}`);
        if (n === 1) await fitPage.screenshot({ path: `${OUT}fit-${viewport.width}-${chats}.png`, fullPage: true });
      }
      await goToPage(fitPage, 1);
    }
    check(fitErrors.length === 0, `no console errors or warnings${fitErrors.length ? `: ${fitErrors.join(" | ")}` : ""}`);
    await fitPage.close();
  }

  // The big figures on the summary cards (Step 11 part 0): "RM 366.00" on Expected was cut off at 1024 px, and
  // "RM 0.00" on Paid ran past its card's padding. Each figure's text must end inside its card's padding, at
  // every width where the layout changes, with the demo's amounts AND with a big real total (every order set
  // to 99, through the app's own edit route), so a long amount like "RM 36,234.00" is proven to fit too.
  const figuresCutOff = (page) => page.$$eval(".stat [data-figure]", (els) => els.flatMap((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const card = el.closest(".stat");
    const inner = card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight);
    const over = range.getBoundingClientRect().right - inner;
    return over > 0.5 ? [`${card.id} "${el.textContent.replace(/\s+/g, " ")}" runs ${Math.round(over)} px past its card`] : [];
  }));
  const heroSize = (page) => page.$eval("#stat-expected [data-figure]", (el) => parseFloat(getComputedStyle(el).fontSize));
  const bigVisitor = testVisitor();
  const bigServer = createApp(loadConfig({}), { log: () => {}, visitorsDir: bigVisitor.dir }).listen(0);
  await new Promise((resolve) => bigServer.once("listening", resolve));
  const bigBase = `http://localhost:${bigServer.address().port}`;
  for (const row of (await (await bigVisitor.fetch(`${bigBase}/api/state`)).json()).orders.filter((r) => r.orderStatus === "active")) {
    await bigVisitor.fetch(`${bigBase}/api/orders/${row.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qty: 99 }) });
  }
  try {
    for (const [label, url, who] of [["demo amounts", base, visitor], ["every order x 99", bigBase, bigVisitor]]) {
      console.log(`\nSummary figures fit their cards (${label})`);
      for (const width of [1440, 1280, 1100, 1024, 1023, 820, 768, 641, 640, 390, 320]) {
        const { page: cardPage, errors: cardErrors } = await open({ name: "cards", width, height: 900 }, url, who);
        const problems = await figuresCutOff(cardPage);
        const figures = plain(await cardPage.$$eval(".stat [data-figure]", (els) => els.map((el) => el.textContent).join(" | ")));
        check(problems.length === 0 && cardErrors.length === 0,
          `${width} px: ${figures} (hero ${await heroSize(cardPage)} px)${problems.length ? `: ${problems.join("; ")}` : ""}${cardErrors.length ? ` errors: ${cardErrors.join(" | ")}` : ""}`);
        if (width === 1024) await cardPage.screenshot({ path: `${OUT}cards-1024-${label.replace(/\W+/g, "-")}.png` });
        await cardPage.close();
      }
    }
  } finally {
    bigServer.closeAllConnections();
    bigServer.close();
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
  // Priya wrote "2 boxes": the quantity was known, so choosing the item is the whole fix.
  const midSub = plain(await page.$eval("#drawer-sub", (el) => el.textContent));
  check(midSub === "1 item, RM 36.00 in total" && !(await page.$("#drawer-body .check-text")), `after the item: Priya is clear: "${midSub}"`);

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

  // Step 7a: Jun Wei wrote "Classic is RM15 right?". The seller keeps the menu price.
  console.log("\nJun Wei's price check: Keep menu price");
  await rowOf(page, "Jun Wei").click();
  await page.waitForSelector("#drawer.is-open");
  await page.waitForTimeout(400);
  const junDrawer = plain(await page.$eval("#drawer-body", (el) => el.innerText));
  check(junDrawer.includes("Check: buyer mentioned RM 15.00, menu says RM 18.00.") && (await page.locator(".keep-price").count()) === 1,
    "his drawer shows the price check and ONE Keep menu price button");
  const keepBox = await page.locator(".keep-price").boundingBox();
  check(keepBox.height >= 44, `the button is at least 44 px tall (${keepBox.height} px)`);
  await page.screenshot({ path: `${OUT}1280-laptop-price-check.png` });
  reply = putReply(page);
  await page.click(".keep-price");
  console.log(`      PUT keepMenuPrice -> ${(await reply).status()}`);
  await page.waitForTimeout(200);
  const junSub = plain(await page.$eval("#drawer-sub", (el) => el.textContent));
  check(junSub === "2 items, RM 62.00 in total" && !(await page.locator(".keep-price").count()) && !(await page.$("#drawer-body .check-text")),
    `after Keep menu price: Jun Wei is clear at the MENU price: "${junSub}"`);
  await page.waitForSelector("#drawer mark.hl-price");
  check(!(await page.$("#drawer mark.hl-price-check")), "and his RM15 is no longer marked amber (a plain price mark now)");
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
    check(pinned.includes("9 orders ready") && pinned.includes("RM 446.00"), `${label}: totals updated to 9 orders, RM 446.00`);
    check(cards.includes("Expected RM 446.00") && cards.includes("Needs check 0"), `${label}: summary cards updated`);
    await goToBuyer(page, "Jun Wei");
    check(!(await isUnclear(rowOf(page, "Jun Wei"))), `${label}: Jun Wei's row is clear`);
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
