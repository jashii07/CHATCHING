// Tests for the buyer's "Your order" page (6 Nov): one private link per sent invoice, the order as the buyer
// sees it, "Looks right" / "Something's wrong", live status and the pickup QR once paid.
// Security cases on purpose: a wrong link, another buyer's link, a reset or replaced batch, a note with HTML in
// it, no visitor id or other buyer on the page, and the same headers and Origin rule as the rest of the site.
// PayPal is the FAKE in scripts/fake-paypal.mjs; the clock is ours, so no test waits 10 real seconds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { CACHE_MS } from "../src/status.js";
import { formatMoney } from "../src/money.js";
import { ORDER_LINK_GONE } from "../src/order-links.js";
import { demoRows, demoSource } from "../src/store.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";
import { testVisitor } from "../scripts/test-visitor.mjs";

const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const MENU = JSON.parse(readFileSync(new URL("../data/menu.json", import.meta.url), "utf8"));
const RM = (amount) => formatMoney(amount, "MYR");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ visitor = testVisitor(), fake = fakePayPal(), limits, env = FAKE_KEYS } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const paypal = createPayPal({ clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "", fetch: fake.fetch });
  const server = createApp(loadConfig(env), { log: () => {}, visitorsDir: visitor.dir, paypal, now, ...(limits && { limiter: createRateLimiter({ limits, now }) }) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  // A buyer: plain fetch, no cookie (the buyer is not the seller's visitor).
  const raw = async (path, method = "GET", body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  const seller = async (path, method = "GET", body) => {
    const res = await visitor.fetch(base + path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const app = {
    base, fake, visitor, raw, seller,
    tick: (ms) => (clock += ms),
    state: async () => (await seller("/api/state")).body,
    send: () => seller("/api/invoices", "POST", {}),
    view: (token, headers) => raw("/api/order/view", "POST", { token }, headers),
    answer: (token, body, headers) => raw("/api/order/answer", "POST", { token, ...body }, headers),
    textsOf: async (buyer) => (await app.state()).texts.find((t) => t.buyer === buyer),
    rowsOf: async (buyer) => (await app.state()).orders.filter((row) => row.buyer === buyer),
    // The buyer link inside the Copy message, and its token (the part after #).
    linkOf: async (buyer) => (await app.textsOf(buyer)).message.match(/https?:\/\/\S+\/order#\S+$/)?.[0],
    tokenOf: async (buyer) => (await app.linkOf(buyer)).split("#")[1],
  };
  return app;
}

async function sent(options) {
  const app = await start(options);
  await app.send();
  app.tick(CACHE_MS);
  return app;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---- The link ----

test("each sent invoice gets its own private link, and Copy message and the reminder send it, not PayPal's link", async () => {
  const app = await sent();
  const [lina] = await app.rowsOf("Lina");
  const link = await app.linkOf("Lina");
  assert.ok(link, "the Copy message ends with the buyer's order page");
  assert.ok(link.startsWith(`${app.base}/order#`));
  assert.match(link.split("#")[1], TOKEN, "43 characters of base64url: 256 bits");
  const { message, reminder } = await app.textsOf("Lina");
  assert.ok(!message.includes(lina.payerLink), "the bare PayPal link is no longer in the message");
  assert.ok(reminder.endsWith(link), "the reminder sends the same page");
  assert.match(lina.payerLink, /^https:\/\/www\.sandbox\.paypal\.com\//, "Open invoice keeps PayPal's link for the seller");
  const links = new Set();
  for (const buyer of ["Lina", "Hafiz", "Mei Ling", "Aisyah", "Arif", "Sarah", "Kak Ros"]) links.add(await app.linkOf(buyer));
  assert.equal(links.size, 7, "one different link per buyer");
  assert.equal((await app.textsOf("Priya")).message, null, "an unclear buyer has no invoice, so no link");
});

test("the link stays the same on every reload and on a paired phone, so a link already sent keeps working", async () => {
  const app = await sent();
  const first = await app.linkOf("Lina");
  assert.equal(await app.linkOf("Lina"), first);
  const phone = await fetch(`${app.base}/api/state`, { headers: { Cookie: app.visitor.cookie } });
  assert.equal((await phone.json()).texts.find((t) => t.buyer === "Lina").message.split(" ").at(-1), first);
});

test("the link is stored only as a hash: never in the seller's file, never in the server's link index", async () => {
  const app = await sent();
  const token = await app.tokenOf("Lina");
  const files = readdirSync(app.visitor.dir).map((name) => readFileSync(join(app.visitor.dir, name), "utf8"));
  assert.ok(files.length >= 2, "the seller's table and the link index");
  for (const text of files) assert.ok(!text.includes(token), "the token itself is saved nowhere");
  const saved = JSON.parse(readFileSync(app.visitor.file, "utf8"));
  assert.ok(saved.rows.filter((row) => row.buyer === "Lina").every((row) => row.orderLink === sha256(token)), "the buyer's rows hold its SHA-256 hash");
  assert.ok(files.some((text) => text.includes(sha256(token))), "the index finds the table by the hash");
});

// ---- The page ----

test("the buyer's page: items, quantities, total from the menu, date, delivery, Pay, Not paid; no cookie, no-store", async () => {
  const app = await sent();
  const [lina] = await app.rowsOf("Lina");
  const res = await app.view(await app.tokenOf("Lina"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null, "opening the page makes no visitor");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { order } = res.body;
  assert.deepEqual(
    { buyer: order.buyer, items: order.items, total: order.total, dates: order.dates, fulfilment: order.fulfilment, status: order.status, statusLabel: order.statusLabel, payLink: order.payLink, answer: order.answer, qr: order.qr },
    {
      buyer: "Lina", items: [{ qty: 3, name: "Classic brownies (box of 6)", lineTotal: RM("54.00") }], total: RM("54.00"),
      dates: ["Sat 31 Oct"], fulfilment: "Delivery", status: "unpaid", statusLabel: "Not paid", payLink: lina.payerLink, answer: null, qr: null,
    },
  );
});

test("the page shows the buyer's own messages, marked as in the drawer, and never another buyer's", async () => {
  // Aisyah's "same as Lina": the AI cites Lina's messages too. Aisyah must not see them.
  const rows = demoRows(MENU).map((row) => (row.buyer === "Aisyah" ? { ...row, sourceMsgs: [1, 4, 5] } : row));
  const app = await sent({ visitor: testVisitor({ rows }) });
  const { order } = (await app.view(await app.tokenOf("Aisyah"))).body;
  assert.equal(order.messages.length, 1);
  const text = order.messages[0].parts.map((part) => part.text).join("");
  assert.equal(text, "same as Lina for me pls! I'll pick up on saturday", "her own words, without her name in front");
  assert.ok(order.messages[0].parts.some((part) => part.mark === "fulfilment"), "the same marks as the drawer");
  assert.equal(order.messages[0].when, "Wed 28 Oct, 10:20");
  const lina = (await app.view(await app.tokenOf("Lina"))).body.order;
  assert.deepEqual(lina.messages.map((m) => m.when), ["Wed 28 Oct, 09:02", "Wed 28 Oct, 10:05", "Wed 28 Oct, 21:30"]);
});

test("nothing on the page names the seller's visitor, the batch, another buyer or the AI's note", async () => {
  const app = await sent();
  const state = await app.state();
  const { text } = await app.view(await app.tokenOf("Mei Ling"));
  assert.ok(!text.includes(app.visitor.id), "no visitor id");
  assert.ok(!text.includes(state.batch), "no batch id");
  for (const other of ["Lina", "Hafiz", "Aisyah", "Arif", "Priya", "Danish", "Sarah", "Kak Ros", "Jun Wei"]) assert.ok(!text.includes(other), `no ${other}`);
  const note = state.orders.find((row) => row.buyer === "Mei Ling").note;
  if (note) assert.ok(!text.includes(note), "the AI's note is the seller's, not the buyer's");
  const { order } = JSON.parse(text);
  assert.deepEqual(order.items.map((item) => [item.qty, item.name]), [[1, "Cheese brownies (box of 6)"], [2, "Choc chip cookies (jar)"]]);
  assert.equal(order.total, RM("72.00"));
});

// ---- Wrong links ----

test("a wrong, made-up, malformed or missing link gets the same words, and no cookie", async () => {
  const app = await sent();
  const real = await app.tokenOf("Lina");
  const flipped = (real[0] === "A" ? "B" : "A") + real.slice(1);
  for (const token of [flipped, "x".repeat(43), "short", "", "../../etc/passwd", `${real}.`]) {
    const res = await app.view(token);
    assert.equal(res.status, 200, JSON.stringify(token));
    assert.deepEqual(res.body, { notice: ORDER_LINK_GONE, gone: true }, JSON.stringify(token));
    assert.equal(res.headers.get("set-cookie"), null);
  }
  const bad = await app.raw("/api/order/view", "POST", { token: 42 });
  assert.equal(bad.status, 400, "a wrongly shaped request is a 400");
});

test("one buyer's link opens only that buyer: Lina's link can't see or answer for Mei Ling", async () => {
  const app = await sent();
  const lina = await app.tokenOf("Lina");
  await app.answer(lina, { answer: "wrong", note: "only 2 boxes" });
  const mei = await app.rowsOf("Mei Ling");
  assert.ok(mei.every((row) => !row.buyerAnswer), "Mei Ling's rows are untouched");
  assert.equal((await app.view(await app.tokenOf("Mei Ling"))).body.order.answer, null);
  assert.equal((await app.view(lina)).body.order.buyer, "Lina");
});

test("a link belongs to one seller's table: another seller's cookie changes nothing, and their links never cross", async () => {
  const one = testVisitor();
  const two = testVisitor({ dir: one.dir });
  const app = await sent({ visitor: one });
  await fetch(`${app.base}/api/invoices`, { method: "POST", headers: { ...JSON_HEADERS, Cookie: two.cookie }, body: "{}" });
  const twoState = await (await fetch(`${app.base}/api/state`, { headers: { Cookie: two.cookie } })).json();
  const twoLink = twoState.texts.find((t) => t.buyer === "Lina").message.split(" ").at(-1);
  const oneToken = await app.tokenOf("Lina");
  assert.notEqual(twoLink.split("#")[1], oneToken, "the same buyer name in two tables gets two different links");
  const asTwo = await app.view(oneToken, { Cookie: two.cookie });
  assert.equal(asTwo.body.order.payLink, (await app.rowsOf("Lina"))[0].payerLink, "the link, not the cookie, picks the order");
  assert.notEqual(asTwo.body.order.payLink, twoState.orders.find((row) => row.buyer === "Lina").payerLink, "never the other table's Lina");
});

test("the link stops working once the batch is reset or replaced (New batch)", async () => {
  for (const route of ["/api/reset", "/api/new-batch"]) {
    const app = await sent();
    const token = await app.tokenOf("Lina");
    assert.equal((await app.view(token)).body.order.buyer, "Lina");
    await app.seller(route, "POST", {});
    assert.deepEqual((await app.view(token)).body, { notice: ORDER_LINK_GONE, gone: true }, route);
    assert.deepEqual((await app.answer(token, { answer: "ok" })).body, { notice: ORDER_LINK_GONE, gone: true }, route);
  }
});

// ---- Answers ----

test("Looks right: saved on the buyer's rows for the seller; money, items and the invoice never change", async () => {
  const app = await sent();
  const before = await app.state();
  const res = await app.answer(await app.tokenOf("Lina"), { answer: "ok" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.order.answer, { answer: "ok", note: "" });
  const after = await app.state();
  const strip = (rows) => rows.map(({ buyerAnswer, ...row }) => row);
  assert.deepEqual(strip(after.orders), strip(before.orders), "nothing else on any row changed");
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.summary, before.summary);
  assert.ok(after.orders.filter((row) => row.buyer === "Lina").every((row) => row.buyerAnswer?.answer === "ok"));
});

test("Something's wrong: the short note is saved for the seller; a later answer replaces it", async () => {
  const app = await sent();
  const token = await app.tokenOf("Hafiz");
  const res = await app.answer(token, { answer: "wrong", note: "  I asked for   2 cheesecakes \n not 1  " });
  assert.deepEqual(res.body.order.answer, { answer: "wrong", note: "I asked for 2 cheesecakes not 1" }, "spaces and line breaks tidied");
  const [hafiz] = await app.rowsOf("Hafiz");
  assert.equal(hafiz.buyerAnswer.note, "I asked for 2 cheesecakes not 1");
  assert.equal(hafiz.qty, 1, "the buyer can never change a quantity");
  assert.equal(hafiz.lineTotal, "45.00");
  await app.answer(token, { answer: "wrong" });
  assert.deepEqual((await app.rowsOf("Hafiz"))[0].buyerAnswer.note, "", "the note is optional");
  await app.answer(token, { answer: "ok" });
  assert.equal((await app.rowsOf("Hafiz"))[0].buyerAnswer.answer, "ok");
});

test("a note is untrusted text: HTML stays as plain characters, hidden controls go, over 200 is refused", async () => {
  const app = await sent();
  const token = await app.tokenOf("Lina");
  const xss = `<img src=x onerror="alert(1)"><script>alert('hi')</script>`;
  const res = await app.answer(token, { answer: "wrong", note: xss });
  assert.equal(res.body.order.answer.note, xss, "kept exactly as typed: the pages show it as text, never as HTML");
  assert.equal((await app.rowsOf("Lina"))[0].buyerAnswer.note, xss);
  const tricky = await app.answer(token, { answer: "wrong", note: "two‮boxes\u0007‏ please" });
  assert.equal(tricky.body.order.answer.note, "twoboxes please", "direction marks and control characters removed");
  assert.equal((await app.answer(token, { answer: "wrong", note: "é".repeat(200) })).status, 200, "200 letters fit");
  assert.equal((await app.answer(token, { answer: "wrong", note: "🎂".repeat(200) })).status, 200, "an emoji counts as one");
  const long = await app.answer(token, { answer: "wrong", note: "x".repeat(201) });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /200 characters/);
  for (const body of [{ answer: "maybe" }, { answer: "ok", note: "a note" }, { answer: "wrong", note: 5 }, { answer: "ok", qty: 9 }, { answer: "ok", price: "1.00" }]) {
    assert.equal((await app.answer(token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await app.rowsOf("Lina"))[0].qty, 3);
});

// ---- Status and the QR ----

test("live status through the status code: Not paid, then Paid with the pickup QR, then Collected; Pay goes once paid", async () => {
  const app = await sent();
  const token = await app.tokenOf("Aisyah");
  const [row] = await app.rowsOf("Aisyah");
  assert.equal((await app.view(token)).body.order.statusLabel, "Not paid");
  app.fake.pay(row.invoiceId);
  app.tick(CACHE_MS);
  const paid = (await app.view(token)).body.order;
  assert.equal(paid.status, "paid");
  assert.equal(paid.statusLabel, "Paid");
  assert.equal(paid.payLink, null, "nobody is asked to pay twice");
  assert.match(paid.qr.png, /^[A-Za-z0-9+/=]+$/, "PayPal's QR, as Base64 PNG");
  assert.equal((await app.rowsOf("Aisyah"))[0].invoiceStatus, "Paid", "the seller's table learned it too");
  await app.seller("/api/pickup/collected", "POST", { invoiceId: row.invoiceId });
  const done = (await app.view(token)).body.order;
  assert.equal(done.statusLabel, "Collected");
  assert.equal(done.qr, null, "already collected: no QR to show");
});

test("the status cache protects PayPal: views within 10 seconds ask PayPal nothing", async () => {
  const app = await sent();
  const token = await app.tokenOf("Lina");
  await app.view(token);
  const gets = () => app.fake.calls.filter((c) => c.kind === "get").length;
  const n = gets();
  await app.view(token);
  await app.view(token);
  assert.equal(gets(), n);
});

test("the QR is asked from PayPal once per invoice; a cash payment shows as Paid", async () => {
  const app = await sent();
  const token = await app.tokenOf("Lina");
  const [row] = await app.rowsOf("Lina");
  await app.seller(`/api/invoices/${row.invoiceId}/payment`, "POST", { method: "CASH" });
  await app.view(token);
  app.tick(CACHE_MS);
  const order = (await app.view(token)).body.order;
  assert.equal(order.statusLabel, "Paid");
  assert.equal(app.fake.count("qr"), 1);
});

// ---- Limits and headers ----

test("rate limited: friendly words, no PayPal call", async () => {
  const limits = { ...RATE_LIMITS, order: { limit: 2, windowMs: 600_000 }, orderAnswer: { limit: 1, windowMs: 600_000 } };
  const app = await sent({ limits });
  const token = await app.tokenOf("Lina");
  await app.view(token);
  await app.view(token);
  const third = await app.view(token);
  assert.equal(third.status, 200);
  assert.deepEqual(third.body, { notice: slowDown(600_000), rateLimited: true });
  await app.answer(token, { answer: "ok" });
  assert.equal((await app.answer(token, { answer: "wrong" })).body.rateLimited, true);
  assert.equal((await app.rowsOf("Lina"))[0].buyerAnswer.answer, "ok", "the limited answer changed nothing");
});

test("the page and its API have the site's headers; another website can't answer for a buyer", async () => {
  const app = await sent();
  const page = await app.raw("/order");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.equal(page.headers.get("set-cookie"), null);
  assert.doesNotMatch(page.text, /https?:\/\//, "the page holds a key in its address, so it loads nothing from other sites");
  const token = await app.tokenOf("Lina");
  const evil = await app.answer(token, { answer: "wrong", note: "hi" }, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.ok(!(await app.rowsOf("Lina"))[0].buyerAnswer);
});

test("without PayPal keys the page still shows the order from the saved status", async () => {
  const visitor = testVisitor();
  const app = await sent({ visitor });
  const token = await app.tokenOf("Lina");
  const quiet = await start({ visitor, env: {} });
  const { order } = (await quiet.view(token)).body;
  assert.equal(order.statusLabel, "Not paid");
  assert.equal(order.buyer, "Lina");
});

test("demo source sanity: the tests above read the real demo chats", () => {
  assert.ok(demoSource().text.includes("Aisyah: same as Lina"));
});
