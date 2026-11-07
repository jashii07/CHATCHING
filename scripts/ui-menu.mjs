// The browser check for "My menu" (7 Nov), at 1280x800 and 390x844:
//   Open My menu -> the demo bakery's 5 items. A price of 0 is refused on the page itself (no request, no red line).
//   An item named like HTML shows as plain text and runs nothing; Remove takes it away again.
//   Add "Pizza RM 25.00", paste "[06/11 10:00 AM] Amir: 2 pizzas pls", Read orders (no AI key here, so the AI
//   can't read) -> Read without AI -> 2 x Pizza, RM 50.00, with NO Gemini call and the AI counter unchanged.
//   Send invoices -> My menu is locked ("Start a New batch to change your menu"), with no Edit, Remove or Add.
//   New batch -> unlocked; Load demo asks "This replaces your menu with the demo bakery menu." first: No keeps it,
//   Yes brings the demo menu back; Reset demo with the demo menu doesn't ask about the menu.
// PayPal is the FAKE in scripts/fake-paypal.mjs, Gemini a fetch that counts calls: no network. Fails on any console
// error or warning, any request to another site, and sideways scrolling. Run: npm run ui-menu.
// Screenshots go to tmp/screenshots-menu/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi } from "../src/ai.js";
import { createPayPal } from "../src/paypal.js";
import { fakePayPal } from "./fake-paypal.mjs";

const OUT = fileURLToPath(new URL("../tmp/screenshots-menu/", import.meta.url));
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456", AI_MODE: "real" };
const WIDTHS = [
  { name: "laptop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
const ROWS = ".ag-grid-scrolling-container > .ag-row";
const AMIR = "[06/11 10:00 AM] Amir: 2 pizzas pls";
const XSS = '<img src=x onerror="window.__menuXss=1">';
const DEMO_ASK = "This replaces your menu with the demo bakery menu.";
const LOCKED = "Invoices are sent for this batch. Start a New batch to change your menu.";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};
const plain = (text) => String(text).replace(/\s+/g, " ").trim();

async function startServer() {
  const visitorsDir = mkdtempSync(join(tmpdir(), "chatching-ui-menu-"));
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const gemini = [];
  // Real AI mode with no key: the AI can't read, so the page offers Read without AI. Any Gemini call is counted.
  const ai = createAi({ mode: "real", apiKey: "", cacheDir: mkdtempSync(join(tmpdir(), "chatching-ui-menu-cache-")), fetch: async (url) => (gemini.push(url), new Response("{}", { status: 500 })), log: () => {} });
  const server = createApp(loadConfig(FAKE_KEYS), { log: () => {}, visitorsDir, paypal, ai }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, fake, gemini, ai };
}

const drawerOpen = (page) => page.$eval("#drawer", (el) => !el.hidden);
const menuNames = (page) => page.$$eval("#drawer-body .menu-card .menu-name", (els) => els.map((el) => el.textContent));
const drawerError = (page) => page.$eval("#drawer-error", (el) => (el.hidden ? "" : el.textContent));
// The menu as the server holds it for this visitor (the page's footer showed this until the 8 Nov polish).
const footer = (page) => page.evaluate(() => fetch("/api/state").then((r) => r.json())
  .then((s) => `Menu: ${s.menu.items.length} items in ${s.menu.currency}${s.menuIsDemo === false ? " (yours)" : ""}`));
const noSideways = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth);
const waitSaved = (page) => page.waitForFunction(() => document.getElementById("saved-note").textContent.includes("Saved"), null, { timeout: 5000 }).catch(() => {});

async function addItem(page, name, price, otherNames = "") {
  await page.fill("#menu-add-name", name);
  await page.fill("#menu-add-price", price);
  await page.fill("#menu-add-others", otherNames);
  await page.click("#menu-add");
}

try {
  for (const viewport of WIDTHS) {
    const { server, fake, gemini, ai } = await startServer();
    const base = `http://localhost:${server.address().port}`;
    const page = await browser.newPage({ viewport });
    const errors = [];
    const outside = [];
    const menuRequests = [];
    const dialogs = [];
    let answer = true; // what the next confirm() gets
    page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && errors.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("request", (req) => {
      if (!/^(data|blob):/.test(req.url()) && new URL(req.url()).origin !== base) outside.push(req.url());
      if (req.url().includes("/api/menu/")) menuRequests.push(`${req.method()} ${new URL(req.url()).pathname}`);
    });
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      answer ? dialog.accept() : dialog.dismiss();
    });
    const shot = (name, full = false) => page.screenshot({ path: `${OUT}${viewport.width}-${viewport.name}-${name}.png`, fullPage: full });

    console.log(`\n${viewport.width} px (${viewport.name})`);
    await page.goto(base);
    await page.waitForSelector(".ag-overlay");
    await page.waitForTimeout(300);
    const callsBefore = ai.callsLeft();

    // ---- My menu opens with the demo bakery menu ----
    check(await page.isVisible("#my-menu"), "My menu sits next to Load demo");
    await page.$eval("#my-menu", (el) => el.scrollIntoView({ block: "center" }));
    await shot("button");
    await page.click("#my-menu");
    await page.waitForTimeout(400);
    check(await drawerOpen(page) && plain(await page.textContent("#drawer-title")) === "My menu", "My menu opens in the drawer");
    check((await menuNames(page)).length === 5 && (await menuNames(page))[0] === "Classic brownies (box of 6)", "the demo bakery's 5 items");
    check(plain(await page.textContent("#drawer-sub")) === "5 items. Prices come from here, never from the AI.", "the drawer says where prices come from");
    await shot("menu-demo");

    // ---- A bad price is refused on the page: no request, no red line ----
    await addItem(page, "Pizza", "0");
    await page.waitForTimeout(200);
    check((await drawerError(page)) === "Error: That item was not saved (A price must be more than 0).", "a price of 0 is refused with the reason");
    check(menuRequests.length === 0, "nothing was sent to the server");
    check(await page.evaluate(() => document.activeElement.id) === "menu-add-price", "focus goes to the price box");

    // ---- A name like HTML is plain text and runs nothing ----
    await addItem(page, XSS, "5");
    await waitSaved(page);
    check((await menuNames(page)).includes(XSS), "the HTML-like name shows as its own text");
    check(!(await page.evaluate(() => window.__menuXss)) && (await page.$$("#drawer-body img")).length === 0, "nothing in it ran, and no image was made");
    const xssId = await page.$eval("#drawer-body .menu-card:last-of-type .menu-remove", (el) => el.dataset.item);
    answer = true;
    await page.click(`#menu-remove-${xssId}`);
    await waitSaved(page);
    await page.waitForTimeout(200);
    check(dialogs.at(-1) === `Remove ${XSS} from your menu?` && !(await menuNames(page)).includes(XSS), "Remove asks first, then takes it away");

    // ---- Add Pizza RM 25.00 ----
    await addItem(page, "Pizza", "25.00");
    await waitSaved(page);
    const pizza = await page.$$eval("#drawer-body .menu-card", (cards) => cards.map((c) => c.innerText.replace(/\s+/g, " ").trim()).find((t) => t.startsWith("Pizza")));
    check(/^Pizza RM.25\.00 No other names\./.test(pizza ?? ""), `Pizza RM 25.00 is on the menu (${pizza})`);
    check(plain(await page.textContent("#saved-note")) === "Saved" && (await drawerError(page)) === "", "Saved, and no error");
    check((await page.$eval("#menu-add-name", (el) => el.value)) === "", "the Add card is empty again for the next item");
    check(await noSideways(page), "no sideways scroll");
    await page.$eval("#drawer-body", (el) => el.scrollTo(0, el.scrollHeight));
    await shot("menu-pizza");
    check((await footer(page)).includes("Menu: 6 items in MYR (yours)"), "the menu is the seller's own: 6 items");

    // ---- Edit: another item's Edit shows that item's own values (not what was typed before); Enter saves ----
    await page.click("#menu-edit-classic_brownies");
    await page.fill("#menu-change-price", "99");
    await page.click("#menu-edit-cookies");
    const form = await page.evaluate(() => [document.getElementById("menu-change-name").value, document.getElementById("menu-change-price").value]);
    check(JSON.stringify(form) === JSON.stringify(["Choc chip cookies (jar)", "25.00"]), `Edit on another item shows its own name and price (${form})`);
    await page.click("#menu-cancel");
    check((await page.$$("#menu-change-form")).length === 0, "Cancel closes the form, nothing saved");
    await page.click('[aria-label="Edit Pizza"]');
    await page.fill("#menu-change-others", "pz, pizza pie");
    await page.press("#menu-change-others", "Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".menu-other")].some((el) => el.textContent === "Other names: pz, pizza pie"), null, { timeout: 5000 }).catch(() => {});
    const cards = await page.$$eval("#drawer-body .menu-card", (els) => els.map((c) => c.innerText.replace(/\s+/g, " ").trim()));
    check(cards.some((t) => t.startsWith("Pizza") && t.includes("Other names: pz, pizza pie")), "Enter saves Pizza's other names");
    check(cards.some((t) => /^Classic brownies \(box of 6\) RM.18\.00/.test(t)), "the brownies kept RM 18.00 (the typed 99 was never saved)");
    await page.click("#drawer-done");
    await page.waitForTimeout(300);

    // ---- Paste a pizza chat, Read without AI: 2 x Pizza, RM 50.00, no Gemini call ----
    await page.fill("#chat", AMIR);
    await page.fill("#chat-date", "2026-11-06");
    await page.click("#read-orders");
    await page.waitForSelector("#read-without-ai:not([hidden])", { timeout: 5000 }).catch(() => {});
    check(await page.isVisible("#read-without-ai"), "the AI can't read here (no key), so Read without AI is offered");
    await page.click("#read-without-ai");
    await page.waitForSelector(ROWS, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const row = plain(await page.$eval(ROWS, (el) => el.innerText).catch(() => ""));
    check(row.includes("Amir") && row.includes("2 × Pizza") && /RM.50\.00/.test(row), `the row: Amir, 2 × Pizza, RM 50.00 (${row})`);
    check(gemini.length === 0 && ai.callsLeft() === callsBefore, "no Gemini call, and the AI counter is unchanged");
    const expected = plain(await page.$eval("#stat-expected [data-figure]", (el) => el.textContent));
    check(/RM.50\.00/.test(expected), `the Expected card says RM 50.00 (${expected})`);
    check(await noSideways(page), "no sideways scroll");
    await page.$eval(ROWS, (el) => el.scrollIntoView({ block: "center" }));
    await shot("pizza-read");

    // ---- Send invoices -> the menu is locked ----
    await page.click(viewport.name === "phone" ? ".phone-total [data-send-invoices]" : "#send-invoices");
    await page.waitForFunction(() => /1 of 1 sent/.test(document.getElementById("send-message").textContent), null, { timeout: 8000 }).catch(() => {});
    const invoice = fake.calls.find((c) => c.kind === "create")?.body.items.map((item) => `${item.quantity} x ${item.name} @ ${item.unit_amount.value}`);
    check(JSON.stringify(invoice) === JSON.stringify(["2 x Pizza @ 25.00"]), `the PayPal invoice: 2 x Pizza at 25.00 from the menu (${invoice})`);
    await page.click("#chat-edit").catch(() => {});
    await page.click("#my-menu");
    await page.waitForTimeout(400);
    check(plain(await page.textContent("#menu-locked").catch(() => "")) === LOCKED, "locked: Start a New batch to change your menu");
    check((await page.$$("#drawer-body .menu-edit, #drawer-body .menu-remove, #menu-add-form")).length === 0, "no Edit, Remove or Add while locked");
    await shot("menu-locked");
    await page.click("#drawer-done");
    await page.waitForTimeout(300);

    // ---- New batch -> unlocked; Load demo asks before replacing the menu ----
    answer = true;
    await page.locator("[data-new-batch]:visible").first().click();
    await page.waitForFunction(() => document.getElementById("chat").value === "", null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    check((await page.$$(ROWS)).length === 0 && !(await footer(page)).includes("5 items"), "New batch: an empty table, and the seller's menu stays");
    answer = false;
    await page.click("#load-demo");
    await page.waitForTimeout(400);
    check(dialogs.at(-1) === `Load the demo? ${DEMO_ASK}`, "Load demo asks: This replaces your menu with the demo bakery menu.");
    check((await footer(page)).includes("(yours)") && (await page.$eval("#chat", (el) => el.value)) === "", "No: the menu and the chat box stay as they were");
    answer = true;
    await page.click("#load-demo");
    await page.waitForFunction(() => document.getElementById("chat").value.length > 100, null, { timeout: 5000 }).catch(() => {});
    check((await footer(page)).includes("Menu: 5 items in MYR") && !(await footer(page)).includes("(yours)"), "Yes: the demo bakery menu is back, and the demo chats are in the box");
    const asked = dialogs.length;
    await page.click("#reset-demo");
    await page.waitForTimeout(400);
    check(dialogs.length === asked + 1 && !dialogs.at(-1).includes(DEMO_ASK), "Reset demo with the demo menu doesn't mention the menu");

    check(errors.length === 0, `no console errors or warnings${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    check(outside.length === 0, `no request to another site${outside.length ? `: ${outside.join(", ")}` : ""}`);
    await page.close();
    server.closeAllConnections();
    server.close();
  }
} finally {
  await browser.close();
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed. Screenshots: ${OUT}` : `\nPASS: all checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
