// Tests for "Open on my phone" (device pairing): a one-time link in a QR gives a phone the same table as the
// laptop. The clock is ours, so no test waits 10 real minutes. PayPal is the FAKE in scripts/fake-paypal.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPayPal } from "../src/paypal.js";
import { PAIR_EXPIRED, PAIR_TTL_MS, createPairing, pairQr, qrMatrix } from "../src/pairing.js";
import { createRateLimiter, RATE_LIMITS, slowDown } from "../src/rate-limit.js";
import { VISITOR_COOKIE, isVisitorId } from "../src/visitors.js";
import { fakePayPal } from "../scripts/fake-paypal.mjs";

const jsQR = createRequire(import.meta.url)("jsqr");
const FAKE_KEYS = { PAYPAL_CLIENT_ID: "fake-client-id-123", PAYPAL_CLIENT_SECRET: "fake-secret-456" };
const DEMO = readFileSync(new URL("../data/demo-chats.txt", import.meta.url), "utf8");
const READ = { text: DEMO, chatDate: "2026-10-28" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const VISITOR_A = "a".repeat(32);
const VISITOR_B = "b".repeat(32);
const LINK = /^http:\/\/localhost:\d+\/pair#([A-Za-z0-9_-]{22})$/;

const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function start({ env = FAKE_KEYS, limits } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const logs = [];
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: FAKE_KEYS.PAYPAL_CLIENT_ID, clientSecret: FAKE_KEYS.PAYPAL_CLIENT_SECRET, fetch: fake.fetch });
  const visitorsDir = mkdtempSync(join(tmpdir(), "chatching-pair-"));
  const server = createApp(loadConfig(env), {
    log: (line) => logs.push(line), visitorsDir, paypal, now, ...(limits && { limiter: createRateLimiter({ limits, now }) }),
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { base: `http://localhost:${server.address().port}`, fake, logs, visitorsDir, tick: (ms) => (clock += ms) };
}

// One device: it keeps the cookie the server gives it, like a real browser.
function device(app) {
  let cookie = null;
  const call = async (path, method = "GET", body, headers = {}) => {
    const res = await fetch(app.base + path, { method, headers: { ...JSON_HEADERS, ...(cookie && { Cookie: cookie }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) cookie = setCookies.at(-1).split(";")[0];
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text(), setCookies, cacheControl: res.headers.get("cache-control") };
  };
  return {
    call,
    id: () => cookie?.split("=")[1],
    state: async () => (await call("/api/state")).body,
    newLink: async () => (await call("/api/pair/new", "POST", {})).body,
    open: (code, headers) => call("/api/pair/open", "POST", { code }, headers),
  };
}

const codeIn = (link) => link.match(LINK)[1];

// A laptop with the demo table, ready to pair.
async function laptopWithOrders(app) {
  const laptop = device(app);
  assert.equal((await laptop.call("/api/parse", "POST", READ)).status, 200);
  return laptop;
}

// ---- The code itself ----

test("a code has at least 128 random bits and is safe in a URL", () => {
  const pairing = createPairing();
  const codes = new Set(Array.from({ length: 50 }, (_, i) => pairing.create(`${i}`.padStart(32, "0"))));
  assert.equal(codes.size, 50, "never the same code twice");
  for (const code of codes) {
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(Buffer.from(code, "base64url").length * 8 >= 128);
  }
});

test("it is stored only as a hash: the code itself is nowhere in what the server keeps", () => {
  const codes = new Map();
  const code = createPairing({ codes }).create(VISITOR_A);
  assert.deepEqual([...codes.keys()], [createHash("sha256").update(code).digest("hex")]);
  assert.doesNotMatch(JSON.stringify([...codes]), new RegExp(code));
});

test("it works once", () => {
  const pairing = createPairing();
  const code = pairing.create(VISITOR_A);
  assert.equal(pairing.redeem(code), VISITOR_A);
  assert.equal(pairing.redeem(code), null);
});

test("it works up to just before 10 minutes, and not at 10 minutes", () => {
  let clock = 0;
  const pairing = createPairing({ now: () => clock });
  assert.equal(PAIR_TTL_MS, 10 * 60_000);
  const first = pairing.create(VISITOR_A);
  clock = PAIR_TTL_MS - 1;
  assert.equal(pairing.redeem(first), VISITOR_A);
  const second = pairing.create(VISITOR_A);
  clock += PAIR_TTL_MS;
  assert.equal(pairing.redeem(second), null);
});

test("wrong, empty or oddly shaped codes are refused, and nothing else is used up", () => {
  const pairing = createPairing();
  const code = pairing.create(VISITOR_A);
  for (const bad of ["", "x", code.slice(1), `${code}x`, code.toLowerCase() === code ? code.toUpperCase() : code.toLowerCase(), "../../etc/passwd", null, undefined, 7, {}]) {
    assert.equal(pairing.redeem(bad), null, String(bad));
  }
  assert.equal(pairing.redeem(code), VISITOR_A);
});

test("a new link replaces that visitor's old one, and leaves other visitors' links alone", () => {
  const pairing = createPairing();
  const old = pairing.create(VISITOR_A);
  const other = pairing.create(VISITOR_B);
  const fresh = pairing.create(VISITOR_A);
  assert.equal(pairing.redeem(old), null);
  assert.equal(pairing.redeem(other), VISITOR_B);
  assert.equal(pairing.redeem(fresh), VISITOR_A);
});

test("the server's memory stays small: expired codes go, and only so many are kept", () => {
  let clock = 0;
  const codes = new Map();
  const pairing = createPairing({ now: () => clock, codes, maxCodes: 3 });
  const made = [1, 2, 3, 4].map((n) => pairing.create(String(n).padStart(32, "0")));
  assert.equal(codes.size, 3);
  assert.equal(pairing.redeem(made[0]), null, "the oldest went first");
  assert.ok(pairing.redeem(made[3]));
  clock = PAIR_TTL_MS;
  pairing.create(VISITOR_A);
  assert.equal(codes.size, 1, "expired codes are cleared when a new one is made");
});

test("the QR a phone reads holds exactly the link", () => {
  const link = "https://chatching.onrender.com/pair#AbCdEfGhIjKlMnOpQrStUv";
  const modules = qrMatrix(link);
  const scale = 4;
  const quiet = 4;
  const side = (modules.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const at = ((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx;
        pixels.fill(0, at * 4, at * 4 + 3);
      }
    }
  }));
  assert.equal(jsQR(pixels, side, side).data, link);
  assert.match(pairQr(link), /^data:image\/gif;base64,/);
});

// ---- Through the real app ----

test("the laptop's button gets a link, its QR and how long it lasts, never kept in a cache", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const { status, body, cacheControl } = await laptop.call("/api/pair/new", "POST", {});
  assert.equal(status, 200);
  assert.match(body.link, LINK);
  assert.match(body.qr, /^data:image\/gif;base64,/);
  assert.equal(body.expiresInMs, PAIR_TTL_MS);
  assert.equal(cacheControl, "no-store");
});

test("the visitor id never appears in the link, the QR reply or the phone's reply; only in the cookie", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const reply = await laptop.newLink();
  assert.ok(isVisitorId(laptop.id()));
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(laptop.id()));
  const phone = device(app);
  const opened = await phone.open(codeIn(reply.link));
  assert.deepEqual(opened.body, { paired: true });
  assert.equal(phone.id(), laptop.id());
});

test("the phone gets the same visitor in a safe cookie, and sees the same table", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const phone = device(app);
  assert.equal((await phone.state()).orders.length, 0, "before pairing the phone has its own empty table");
  const { status, setCookies } = await phone.open(codeIn((await laptop.newLink()).link));
  assert.equal(status, 200);
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], new RegExp(`^${VISITOR_COOKIE}=${laptop.id()};`));
  assert.match(setCookies[0], /; HttpOnly/);
  assert.match(setCookies[0], /; SameSite=Lax/);
  assert.deepEqual((await phone.state()).orders, (await laptop.state()).orders);
  assert.equal((await phone.state()).orders.length, 12);
  assert.equal(readdirSync(app.visitorsDir).length, 1, "only one saved table: no extra visitor was made");
});

test("behind Render's HTTPS the cookie is Secure and the link is https", async () => {
  const app = await start({ env: { ...FAKE_KEYS, RENDER: "true" } });
  const laptop = device(app);
  const https = { "X-Forwarded-Proto": "https" };
  const { body } = await laptop.call("/api/pair/new", "POST", {}, https);
  assert.match(body.link, /^https:\/\/localhost:\d+\/pair#/);
  const phone = device(app);
  const { setCookies } = await phone.open(body.link.split("#")[1], https);
  assert.match(setCookies[0], /; Secure/);
  assert.match(setCookies[0], /; HttpOnly/);
  assert.match(setCookies[0], /; SameSite=Lax/);
});

test("it works once: a second phone gets the plain words and keeps its own table", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const code = codeIn((await laptop.newLink()).link);
  const first = device(app);
  assert.deepEqual((await first.open(code)).body, { paired: true });

  const second = device(app);
  const own = (await second.state(), second.id());
  const { status, body, setCookies } = await second.open(code);
  assert.equal(status, 200, "a refused link is words, not a red console line");
  assert.deepEqual(body, { notice: PAIR_EXPIRED });
  assert.equal(PAIR_EXPIRED, "This link has expired. Make a new one on your laptop.");
  assert.deepEqual(setCookies, [], "the phone's cookie is left alone");
  assert.equal(second.id(), own);
  assert.equal((await second.state()).orders.length, 0);
});

test("two phones: each with its own new link, both reach the same table", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const one = device(app);
  await one.open(codeIn((await laptop.newLink()).link));
  const two = device(app);
  await two.open(codeIn((await laptop.newLink()).link));
  assert.deepEqual([one.id(), two.id()], [laptop.id(), laptop.id()]);
});

test("after 10 minutes the link has expired", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const code = codeIn((await laptop.newLink()).link);
  app.tick(PAIR_TTL_MS);
  const phone = device(app);
  const { body, setCookies } = await phone.open(code);
  assert.deepEqual(body, { notice: PAIR_EXPIRED });
  assert.deepEqual(setCookies, []);
});

test("a wrong code gets the same words, so nothing tells a guess how close it was", async () => {
  const app = await start();
  const phone = device(app);
  for (const code of ["", "nope", "A".repeat(22)]) {
    const { status, body, setCookies } = await phone.open(code);
    assert.deepEqual([status, body, setCookies], [200, { notice: PAIR_EXPIRED }, []]);
  }
});

test("a badly shaped request is a 400, and makes no visitor", async () => {
  const app = await start();
  const phone = device(app);
  for (const body of [{}, { code: 7 }, { code: null }]) {
    const res = await phone.call("/api/pair/open", "POST", body);
    assert.deepEqual([res.status, res.setCookies], [400, []]);
  }
});

test("a code in a query string is ignored: only the POST body counts", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const code = codeIn((await laptop.newLink()).link);
  const phone = device(app);
  assert.equal((await phone.call(`/api/pair/open?code=${code}`, "POST", {})).status, 400);
  assert.deepEqual((await phone.open(code)).body, { paired: true }, "and the code was not used up");
});

test("the server logs never hold a code or a visitor id", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  const code = codeIn((await laptop.newLink()).link);
  const phone = device(app);
  await phone.open(code);
  await phone.open(code);
  await phone.call("/pair");
  const logs = app.logs.join("\n");
  assert.match(logs, /POST \/api\/pair\/open 200/);
  assert.doesNotMatch(logs, new RegExp(code));
  assert.doesNotMatch(logs, new RegExp(laptop.id()));
});

test("GET /pair is the phone's page: it sets no cookie, holds no code and loads nothing from other sites", async () => {
  const app = await start();
  const phone = device(app);
  const { status, body, setCookies } = await phone.call("/pair");
  assert.equal(status, 200);
  assert.match(body, /<script[^>]+src="pair\.js"/);
  assert.deepEqual(setCookies, []);
  assert.equal(phone.id(), undefined);
  assert.doesNotMatch(body, /https?:\/\//, "a third-party file on this page would run next to the code");
});

test("the phone's page takes the code from the fragment, clears it first, then POSTs it", () => {
  const script = readFileSync(new URL("../public/pair.js", import.meta.url), "utf8");
  const read = script.indexOf("location.hash");
  const clear = script.indexOf("history.replaceState");
  const post = script.indexOf('"/api/pair/open"');
  assert.ok(read >= 0 && read < clear && clear < post, `hash ${read}, clear ${clear}, post ${post}`);
  assert.match(script, /location\.replace\("\/"\)/, "the /pair page doesn't stay in the phone's history");
});

test("both pair routes are rate limited, and a limited phone doesn't use up the code", async () => {
  const limits = { ...RATE_LIMITS, pairNew: { limit: 1, windowMs: 600_000 }, pairOpen: { limit: 1, windowMs: 600_000 } };
  const app = await start({ limits });
  const laptop = await laptopWithOrders(app);
  const { link } = await laptop.newLink();
  assert.deepEqual(await laptop.newLink(), { notice: slowDown(600_000), rateLimited: true });

  const phone = device(app);
  await phone.open("nope"); // this address's one try
  const limited = await phone.open(codeIn(link));
  assert.deepEqual(limited.body, { notice: slowDown(600_000), rateLimited: true });
  assert.deepEqual(limited.setCookies, []);
  app.tick(600_000);
  assert.deepEqual((await phone.open(codeIn(link))).body, { notice: PAIR_EXPIRED }, "by then it has expired anyway");
});

test("the limits are generous enough for a real seller", () => {
  assert.deepEqual(RATE_LIMITS.pairNew, { limit: 20, windowMs: 600_000 });
  assert.deepEqual(RATE_LIMITS.pairOpen, { limit: 30, windowMs: 600_000 });
});

test("laptop + phone: the phone scans, and the laptop's table shows Collected", async () => {
  const app = await start();
  const laptop = await laptopWithOrders(app);
  await laptop.call("/api/invoices", "POST", {});
  const phone = device(app);
  await phone.open(codeIn((await laptop.newLink()).link));

  const { invoiceId } = (await phone.state()).orders.find((row) => row.buyer === "Lina");
  app.fake.pay(invoiceId);
  app.tick(11_000);
  assert.equal((await phone.call("/api/pickup/check", "POST", { invoiceId })).body.paid, true);
  assert.equal((await phone.call("/api/pickup/collected", "POST", { invoiceId })).body.collected, true);
  assert.equal((await laptop.state()).orders.find((row) => row.buyer === "Lina").collected, true);
});

test("a laptop with an empty table can pair too; what it reads later shows on the phone", async () => {
  const app = await start();
  const laptop = device(app);
  await laptop.state();
  const phone = device(app);
  await phone.open(codeIn((await laptop.newLink()).link));
  assert.equal(existsSync(join(app.visitorsDir, `${laptop.id()}.json`)), false);
  await laptop.call("/api/parse", "POST", READ);
  assert.equal((await phone.state()).orders.length, 12);
});
