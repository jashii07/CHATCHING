// Tests for "My menu" over the API (7 Nov): each visitor has their own menu, saved with their table; a new
// visitor starts with the demo bakery menu; prices only ever come from the visitor's own menu; the menu is
// locked (by the server, not only the page) while the batch has an invoice; Reset demo and Load demo bring the
// demo menu back; and the AI's saved replies are keyed by the menu, so a reply for the demo menu is never used
// with another. PayPal and Gemini are fakes: no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createAi, MOCK_UNKNOWN } from "../src/ai.js";
import { createPayPal } from "../src/paypal.js";
import { MENU_LOCKED } from "../src/menu.js";
import { formatMoney } from "../src/money.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";
import { testVisitor } from "../scripts/test-visitor.mjs";
import { VISITOR_COOKIE } from "../src/visitors.js";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO_MENU = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const DEMO_CHATS = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const AMIR = "[06/11 10:00 AM] Amir: 2 pizzas pls";
const AMIR_DATE = "2026-11-06";
const JSON_HEADERS = { "Content-Type": "application/json" };
const PIZZA = { name: "Pizza", price: "25.00", otherNames: "" };

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

// A fake Gemini that orders 2 of the LAST item id the schema allows (the item just added), and counts calls.
function fakeGemini() {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const ids = body.generationConfig.responseSchema.properties.orders.items.properties.items.items.properties.itemId.enum;
    const orders = [{ buyer: "Amir", status: "active", sourceMsgs: [1], items: [{ itemId: ids.at(-1), qty: 2 }], deliveryDate: null, fulfilment: null, unclear: false, reason: "", note: "" }];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ orders }) }] }, finishReason: "STOP" }] }), { status: 200 });
  };
  return { fetch, calls };
}

// A server with an empty visitors folder (every visitor is new) unless dir is given. ai: "mock" or "real".
async function start({ ai = "mock", dir = mkdtempSync(join(tmpdir(), "chatching-menu-")) } = {}) {
  const fake = fakePayPal();
  const gemini = fakeGemini();
  const cacheDir = mkdtempSync(join(tmpdir(), "chatching-menu-cache-"));
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const app = createApp(loadConfig(FAKE_KEYS), {
    log: () => {}, visitorsDir: dir, paypal,
    ai: createAi({ mode: ai, apiKey: "fake-gemini-key", fetch: gemini.fetch, cacheDir, log: () => {} }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  // One browser: keeps the cookie the server gives it, like a real one.
  const visitor = () => {
    let cookie = "";
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { ...JSON_HEADERS, Cookie: cookie }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      return { status: res.status, body: await res.json() };
    };
    return {
      call,
      id: () => cookie.split("=")[1],
      state: async () => (await call("GET", "/api/state")).body,
      add: (item) => call("POST", "/api/menu/items", item),
      edit: (id, item) => call("PUT", `/api/menu/items/${encodeURIComponent(id)}`, item),
      remove: (id) => call("DELETE", `/api/menu/items/${encodeURIComponent(id)}`),
      demoMenu: () => call("POST", "/api/menu/demo", {}),
      read: (text = AMIR, chatDate = AMIR_DATE, withoutAi = true) => call("POST", "/api/parse", { text, chatDate, withoutAi }),
      send: () => call("POST", "/api/invoices", {}),
    };
  };
  return { dir, fake, gemini, cacheDir, visitor };
}
const itemNamed = (menu, name) => menu.items.find((item) => item.name === name);

test("a new visitor starts with the demo bakery menu; every table reply carries the visitor's menu", async () => {
  const { visitor } = await start();
  const a = visitor();
  const state = await a.state();
  assert.deepEqual(state.menu, DEMO_MENU);
  assert.equal(state.menuIsDemo, true);
  assert.equal(state.menuLocked, false);
  const { body } = await a.add(PIZZA);
  assert.equal(body.menuIsDemo, false);
  assert.ok(itemNamed(body.menu, "Pizza"));
  assert.ok(Array.isArray(body.orders) && body.totals, "the whole table comes back, like the other table changes");
});

test("one visitor's menu never reaches another: not in their state, not in their reading, not editable by them", async () => {
  const { visitor, dir } = await start();
  const a = visitor();
  const b = visitor();
  await b.state();
  const { body } = await a.add(PIZZA);
  const pizza = itemNamed(body.menu, "Pizza");
  assert.equal(itemNamed((await b.state()).menu, "Pizza"), undefined);
  assert.equal((await b.state()).menuIsDemo, true);
  // B reads the same chat: no pizza on B's menu, so B's row needs a check and has no price.
  const theirs = (await b.read()).body.orders;
  assert.equal(theirs.length, 1);
  assert.deepEqual([theirs[0].itemId, theirs[0].lineTotal, theirs[0].unclear], [null, null, true]);
  // B can't change or remove A's item: it isn't on B's menu.
  assert.equal((await b.edit(pizza.id, { ...PIZZA, price: "1.00" })).status, 404);
  assert.equal((await b.remove(pizza.id)).status, 404);
  assert.equal(itemNamed((await a.state()).menu, "Pizza").price, "25.00");
  // Saved with A's table: a restarted server (same folder) still has it, for A only.
  const again = await start({ dir });
  const a2 = again.visitor();
  await a2.call("GET", "/api/health");
  const cookieA = `${VISITOR_COOKIE}=${a.id()}`;
  const res = await fetch(`http://localhost:${servers.at(-1).address().port}/api/state`, { headers: { Cookie: cookieA } });
  assert.equal(itemNamed((await res.json()).menu, "Pizza").price, "25.00");
  assert.ok(readdirSync(dir).includes(`${a.id()}.json`));
});

test("prices only from the visitor's menu: Read without AI, the kitchen list, the Copy texts and a menu price change", async () => {
  const { visitor } = await start();
  const a = visitor();
  await a.add(PIZZA);
  const { body } = await a.read();
  const [row] = body.orders;
  assert.deepEqual([row.buyer, row.itemName, row.qty, row.unitPrice, row.lineTotal, row.unclear], ["Amir", "Pizza", 2, "25.00", "50.00", false]);
  assert.deepEqual(body.totals, { orders: 1, total: "50.00" });
  assert.deepEqual(body.kitchen.days[0].items.map((item) => [item.name, item.qty]), [["Pizza", 2]]);
  // A new price re-prices the unsent rows at once; the AI (or the reader) never set it.
  const pizza = itemNamed(body.menu, "Pizza");
  const changed = (await a.edit(pizza.id, { ...PIZZA, price: "30" })).body;
  assert.deepEqual([changed.orders[0].unitPrice, changed.orders[0].lineTotal], ["30.00", "60.00"]);
  assert.deepEqual(changed.totals, { orders: 1, total: "60.00" });
  // A price in the drawer's add-item request is still refused: the menu is the only source.
  const refused = await a.call("POST", `/api/buyers/${row.id}/items`, { itemId: "cookies", qty: 1, unitPrice: "0.01" });
  assert.equal(refused.status, 400);
});

test("the invoice and the buyer's page use the visitor's menu: names and prices from it, total in sen", async () => {
  const { visitor, fake } = await start();
  const a = visitor();
  const { body } = await a.add({ name: "Pizza", price: "25.50", otherNames: "pz" });
  await a.read();
  const sent = await a.send();
  assert.deepEqual(sent.body.sent.map((s) => s.buyer), ["Amir"]);
  const draft = fake.calls.find((c) => c.kind === "create");
  assert.deepEqual(draft.body.items.map((item) => [item.name, item.quantity, item.unit_amount.value, item.unit_amount.currency_code]), [["Pizza", "2", "25.50", "MYR"]]);
  const { message } = sent.body.texts.find((t) => t.buyer === "Amir");
  assert.match(message, /2 x Pizza/);
  assert.match(message, /RM.51\.00/);
  const token = message.match(/\/order#(\S+)$/)[1];
  const page = await a.call("POST", "/api/order/view", { token });
  assert.deepEqual(page.body.order.items, [{ qty: 2, name: "Pizza", lineTotal: formatMoney("51.00", "MYR") }]);
  assert.equal(itemNamed(body.menu, "Pizza").price, "25.50");
});

test("bad prices and names are refused by the server with the reason; the menu stays as it was", async () => {
  const { visitor } = await start();
  const a = visitor();
  const before = (await a.state()).menu;
  for (const bad of [
    { ...PIZZA, price: "0" }, { ...PIZZA, price: "-3" }, { ...PIZZA, price: "10000.01" }, { ...PIZZA, price: "2.555" }, { ...PIZZA, price: "free" },
    { ...PIZZA, name: "" }, { ...PIZZA, name: "y".repeat(61) }, { ...PIZZA, name: "Burnt CHEESECAKE 6-inch" },
    { ...PIZZA, otherNames: "a,b,c,d,e,f,g,h,i,j,k" }, { ...PIZZA, id: "x" }, { ...PIZZA, currency: "USD" }, [],
  ]) {
    const { status, body } = await a.add(bad);
    assert.equal(status, 400, JSON.stringify(bad));
    assert.ok(body.error, JSON.stringify(bad));
  }
  const cheesecake = (await a.state()).menu.items.find((item) => item.id === "burnt_cheesecake");
  assert.equal((await a.edit("burnt_cheesecake", { name: cheesecake.name, price: "0.001" })).status, 400);
  assert.deepEqual((await a.state()).menu, before);
});

test("locked while the batch has an invoice: the server refuses every menu change, until New batch", async () => {
  const { visitor } = await start();
  const a = visitor();
  await a.add(PIZZA);
  await a.read();
  await a.send();
  const state = await a.state();
  assert.equal(state.menuLocked, true);
  const pizza = itemNamed(state.menu, "Pizza");
  for (const reply of [await a.add({ name: "Burger", price: "9" }), await a.edit(pizza.id, { ...PIZZA, price: "1" }), await a.remove(pizza.id), await a.demoMenu()]) {
    assert.equal(reply.status, 409);
    assert.deepEqual(reply.body, { error: MENU_LOCKED, locked: true });
  }
  assert.equal(MENU_LOCKED, "Invoices are sent for this batch. Start a New batch to change your menu.");
  assert.deepEqual((await a.state()).menu, state.menu, "nothing changed");
  await a.call("POST", "/api/new-batch", {});
  assert.equal((await a.state()).menuLocked, false);
  assert.equal((await a.add({ name: "Burger", price: "9" })).status, 200);
});

test("Reset demo and Load demo's POST /api/menu/demo bring back the demo bakery menu", async () => {
  const { visitor } = await start();
  const a = visitor();
  await a.add(PIZZA);
  const restored = await a.demoMenu();
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.menu, DEMO_MENU);
  assert.equal(restored.body.menuIsDemo, true);
  await a.add(PIZZA);
  await a.read();
  const reset = (await a.call("POST", "/api/reset", {})).body;
  assert.deepEqual(reset.menu, DEMO_MENU);
  assert.equal(reset.menuIsDemo, true);
  assert.equal(reset.orders.length, 0);
});

test("the AI's saved replies are keyed by the menu: the demo reply only with the demo menu, and a new menu is a new read", async () => {
  // Mock mode: the demo chats with the demo menu -> Gemini's saved reply; with a changed menu -> not used.
  const mock = await start();
  const m = mock.visitor();
  const demo = (await m.read(DEMO_CHATS, "2026-10-28", false)).body;
  assert.equal(demo.orders.length > 0, true);
  await m.call("POST", "/api/reset", {});
  await m.add(PIZZA);
  const other = (await m.read(DEMO_CHATS, "2026-10-28", false)).body;
  assert.deepEqual([other.notice, other.readWithoutAi], [MOCK_UNKNOWN, true]);

  // Real mode (fake Gemini): a new menu is one real call with that menu's ids; the same chats + menu again come
  // from the cache (0 calls); a price change is a new menu, so a new call.
  const real = await start({ ai: "real" });
  const r = real.visitor();
  const pizza = itemNamed((await r.add(PIZZA)).body.menu, "Pizza");
  const first = (await r.read(AMIR, AMIR_DATE, false)).body;
  assert.equal(real.gemini.calls.length, 1);
  assert.deepEqual([first.orders[0].itemName, first.orders[0].lineTotal], ["Pizza", "50.00"], "the price is the menu's, the AI only chose the item");
  const ids = real.gemini.calls[0].generationConfig.responseSchema.properties.orders.items.properties.items.items.properties.itemId.enum;
  assert.ok(ids.includes(pizza.id));
  await r.read(AMIR, AMIR_DATE, false);
  assert.equal(real.gemini.calls.length, 1, "same chats + same menu: the saved reply");
  await r.edit(pizza.id, { ...PIZZA, price: "26" });
  await r.read(AMIR, AMIR_DATE, false);
  assert.equal(real.gemini.calls.length, 2, "another menu: never the old reply");
  assert.equal(readdirSync(real.cacheDir).length, 2);
  // The demo chats with the demo menu still use the demo reply in real mode: 0 calls.
  const d = real.visitor();
  assert.ok((await d.read(DEMO_CHATS, "2026-10-28", false)).body.orders.length > 0);
  assert.equal(real.gemini.calls.length, 2);
});

test("untrusted names come back as plain data: HTML and formulas are stored as typed (one line), never run", async () => {
  const { visitor } = await start();
  const a = visitor();
  const name = '<img src=x onerror="alert(1)">';
  const { status, body } = await a.add({ name, price: "5", otherNames: "=SUM(A1), +cmd" });
  assert.equal(status, 200);
  const item = itemNamed(body.menu, name);
  assert.deepEqual(item.otherNames, ["=SUM(A1)", "+cmd"]);
  const page = await (await fetch(`http://localhost:${servers.at(-1).address().port}/`)).text();
  assert.ok(!page.includes("onerror"), "the page itself never holds a menu name");
});
