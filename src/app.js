// Builds the Express app: middleware, API routes and the static page.
// server.js starts it; the tests start it on a free port.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { buyerGroups, checkEdit, keepEarlierInvoice, markEarlierInvoices, recalcRow, repriceRows, summary, toRows, totals } from "./orders.js";
import { MENU_LOCKED, addMenuItem, editMenuItem, loadDemoMenu, removeMenuItem } from "./menu.js";
import { createStore, demoSource } from "./store.js";
import { MAX_AGE_MS, VISITOR_COOKIE, createVisitors, newVisitorId, visitorIdFrom } from "./visitors.js";
import { createAi } from "./ai.js";
import { readPaste } from "./paste.js";
import { checkOrders } from "./validate.js";
import { fallbackParse } from "./fallback-parse.js";
import { createPayPal, NOT_CONFIGURED, PayPalError } from "./paypal.js";
import { createPaymentRecorder } from "./payments.js";
import { createInvoicer } from "./invoices.js";
import { FINAL, createStatusChecker } from "./status.js";
import { ORDER_LINK_GONE, createOrderLinks, hashOf } from "./order-links.js";
import { orderView, readAnswer } from "./order-page.js";
import { createPickup, qrFileName } from "./pickup.js";
import { PAIR_EXPIRED, PAIR_REPLACE, PAIR_TTL_MS, createPairing, pairQr } from "./pairing.js";
import { buyerPanel } from "./panel.js";
import { kitchenList } from "./kitchen.js";
import { buyerMessages } from "./messages.js";
import { createRateLimiter, slowDown } from "./rate-limit.js";
import { sameSiteOnly, securityHeaders } from "./security.js";

const UNREADABLE = "The AI's answer could not be read, so your orders were not changed. Please try again.";
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";
const SENDING = "Invoices are being sent right now. Please wait for that to finish.";
const READING = "Already reading orders. Please wait for that to finish.";
const LOCKED = "Invoice sent: items are locked so the invoice and the table always match.";
const NO_ANSWER = "PayPal didn't answer, so this buyer's invoice may already exist. Click Send invoices to check, or start a New batch.";
const CANCELLED = "This order is cancelled, so it can't be changed.";
export const ORDER_GONE = "This order is no longer in your table.";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// Each visitor's rows live here (git-ignored). Tests pass their own temporary folder.
const VISITORS_DIR = fileURLToPath(new URL("../data/runtime/visitors/", import.meta.url));

const pathOf = (req) => req.originalUrl.split("?")[0];
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.values(Object.freeze(value)).forEach(deepFreeze);
  return value;
};

// ONE error handler: every error becomes JSON { error } with a fitting status code.
// 4xx = the request was wrong, so we say why. 5xx = our problem, so the reply stays
// generic and the details (stack trace) go to the server log only.
export function errorHandler(log) {
  return (err, req, res, next) => {
    const code = err.status ?? err.statusCode;
    const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
    let message;
    if (err.type === "entity.parse.failed") message = "The request body is not valid JSON.";
    else if (err.type === "entity.too.large") message = "The request is too big (max 100 KB).";
    else if (status < 500) message = err.message || "The request could not be handled.";
    else message = "Something went wrong on the server. Please try again.";

    if (status >= 500) log(`ERROR ${req.method} ${pathOf(req)}: ${err.stack ?? err}`);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: message });
  };
}

export function createApp(config, {
  log = console.log,
  visitorsDir = VISITORS_DIR,
  ai = createAi({ mode: config.aiMode, apiKey: config.gemini.apiKey, log }),
  paypal = createPayPal({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypalBaseUrl }),
  now = Date.now, // the clock for the status cache (tests pass their own)
  limiter = createRateLimiter({ now }), // per-visitor limits on the Gemini / PayPal routes (src/rate-limit.js)
} = {}) {
  // The demo bakery menu (data/menu.json), checked once: a bad file stops the server with a clear message. Each
  // visitor starts with it and can change their own copy ("My menu", 7 Nov); req.visitor.store.menu() is the one
  // to use, everywhere. Frozen, so no visitor's change can ever reach this shared copy.
  const demoMenu = deepFreeze(loadDemoMenu());
  // One visitor's table and everything that guards it. The AI, its daily counter, PayPal and the rate limits
  // are shared by all visitors; the rows, the locks and the batch rule are not (src/visitors.js has the why).
  const visitors = createVisitors({
    dir: visitorsDir,
    now,
    open({ file, onNewFile }) {
      const store = createStore({ file, log, onNewFile, demoMenu });
      const menu = () => store.menu(); // the visitor's menu as it is now, never the one at the start
      const invoicer = createInvoicer({ store, paypal, menu, log });
      const status = createStatusChecker({ store, paypal, now, log });
      const payments = createPaymentRecorder({ store, paypal, menu, now });
      const pickup = createPickup({ store, status, menu });
      const visitor = {
        store, invoicer, status, payments, pickup,
        qrCodes: new Map(), // invoice id -> Base64 PNG (a QR code never changes)
        reading: false, // one parse at a time per visitor (it can cost real AI calls)
        readingStage: null, // "reading" or "backup" while a parse runs: the page's loading words (Step 9)
        readingMessages: null, // how many messages that parse reads: "Reading 18 messages..." on the page (6 Nov)
        isBusy: () => visitor.reading || invoicer.isBusy() || payments.isBusy() || status.isBusy(),
      };
      return visitor;
    },
  });
  const pairing = createPairing({ now }); // "Open on my phone": shared by all visitors, in memory only
  const orderLinks = createOrderLinks({ dir: visitorsDir, log }); // the buyers' "Your order" links (src/order-links.js)
  const callsLeft = () => ai.callsLeft?.() ?? null; // a test's own fake AI may have no counter

  // A sent invoice's rows: the ones a buyer's order page shows (cancelled at PayPal included: the page says so).
  const sentInvoice = (row) => row.orderStatus === "active" && row.invoiceId && row.payerLink && row.invoiceStatus !== "Draft";
  // invoice id -> the buyer's order page, for Copy message and the reminder. The link is rebuilt on every call
  // (same link every time); the first time, its hash goes on the buyer's rows and into the index.
  function pagesOf(req) {
    const { store } = req.visitor;
    const origin = `${req.protocol}://${req.get("host")}`;
    const pages = new Map();
    const missing = [];
    for (const row of store.rows()) {
      if (!sentInvoice(row)) continue;
      const token = orderLinks.tokenFor(req.visitorId, store.batch(), row.invoiceId);
      pages.set(row.invoiceId, `${origin}/order#${token}`);
      const hash = hashOf(token);
      if (row.orderLink === hash) continue;
      orderLinks.register(hash, req.visitorId); // first, so the rows never hold a hash the index can't find
      missing.push({ ...row, orderLink: hash });
    }
    if (missing.length) store.replaceMany(missing);
    return pages;
  }
  const textsOf = (req) => {
    const pages = pagesOf(req);
    const { store } = req.visitor;
    return buyerMessages(store.rows(), store.source(), store.menu(), pages);
  };

  // What the table, cards, slim bar, kitchen list, ready-to-send texts and My menu need: the same shape after
  // every change. The menu comes along every time, so a Reset demo or a second device's change reaches the page.
  const table = (req) => {
    const texts = textsOf(req); // first: it may add the link hashes to the rows
    const { store } = req.visitor;
    const rows = store.rows();
    const menu = store.menu();
    return {
      orders: rows, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu), texts, source: store.source(), batch: store.batch(),
      menu, menuIsDemo: store.menuIsDemo(), menuLocked: store.hasInvoices(),
    };
  };
  const app = express();
  app.disable("x-powered-by"); // don't advertise which server software we run
  app.use(securityHeaders); // first, so every reply has them: pages, files, errors and 404s
  // On Render, req.ip is the visitor's address from X-Forwarded-For (the left-most one), not Render's proxy.
  // Render adds to that header instead of replacing it, so a visitor could fake it and dodge the rate
  // limit (DECISIONS.md, Known weaknesses); the daily AI counter still caps the AI calls for everyone.
  if (config.onRender) app.set("trust proxy", true);

  // Too many requests from one visitor -> 200 { notice } with friendly words (no red console error), and
  // the route is not run. extra: more fields for the page (Read orders also offers Read without AI).
  const limited = (route, extra = {}) => (req, res, next) => {
    if (route === "parse" && req.body?.withoutAi === true) return next(); // no AI call, nothing to protect
    const waitMs = limiter.take(route, req.ip);
    if (waitMs === null) return next();
    log(`Rate limit: too many ${route} requests from one visitor; asked to wait ${Math.ceil(waitMs / 1000)} s.`);
    res.json({ notice: slowDown(waitMs), rateLimited: true, ...extra });
  };

  // One log line per API request: method, path, status, time in ms.
  app.use("/api", (req, res, next) => {
    const start = performance.now();
    res.on("finish", () => {
      log(`${req.method} ${pathOf(req)} ${res.statusCode} ${Math.round(performance.now() - start)}ms`);
    });
    next();
  });

  app.use(sameSiteOnly); // above the rate limits and the visitor step: a refused request costs and creates nothing

  // Reads JSON request bodies (the chat paste). 100 KB is plenty for 15,000 characters.
  app.use(express.json({ limit: "100kb" }));

  // For Render's health check and a quick "is it up?": only ok and the app's version, never keys or settings.
  // no-store: a version check after a deploy must come from the server, never from a cached reply (2 Nov).
  app.get("/api/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, version: VERSION });
  });

  // "Open on my phone", the phone's side. Above the visitor step on purpose: a phone that isn't paired yet gets
  // no new visitor from this route, and a refused link leaves its cookie alone. Wrong, used and expired all get
  // the same friendly words (200, no red console line). The id goes in the cookie only, never in a body or a URL.
  // A browser with orders of its own is asked first (a stranger's pairing QR can reach a seller's phone through
  // Pickup scan): { confirm } changes nothing and keeps the code alive, and { replace: true } is the seller's yes.
  const visitorCookie = (req) => ({ httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: MAX_AGE_MS });
  app.get("/pair", (req, res) => res.sendFile("pair.html", { root: PUBLIC_DIR }));
  const wouldLoseOrders = (req, target) => {
    const own = visitorIdFrom(req.headers.cookie);
    if (!own || own === target) return false;
    const { store } = visitors.get(own);
    return store.rows().length > 0 || store.batches().some((saved) => !saved.fromReset);
  };
  app.post("/api/pair/open", limited("pairOpen"), (req, res) => {
    const { code, replace = false } = req.body ?? {};
    if (typeof code !== "string" || typeof replace !== "boolean") return res.status(400).json({ error: 'Send { "code": "..." }.' });
    const target = pairing.peek(code);
    if (!target) return res.json({ notice: PAIR_EXPIRED });
    if (!replace && wouldLoseOrders(req, target)) return res.json({ confirm: PAIR_REPLACE });
    const id = pairing.redeem(code);
    res.cookie(VISITOR_COOKIE, id, visitorCookie(req));
    res.json({ paired: true });
  });

  // The buyer's "Your order" page (6 Nov). Above the visitor step on purpose, like pairing: a buyer is not the
  // seller's visitor, so these routes never set or read the visitor cookie. The token (after the # in the
  // link) comes in a POST body, never in a URL, so it stays out of every log. A wrong link, another table's
  // link and a link from a reset or replaced batch all get the same words (200, no red console line).
  app.get("/order", (req, res) => res.sendFile("order.html", { root: PUBLIC_DIR }));
  const GONE = { notice: ORDER_LINK_GONE, gone: true };
  const orderFor = (token) => {
    const found = orderLinks.find(token);
    if (!found) return null;
    const visitor = visitors.get(found.visitorId);
    const rows = () => visitor.store.rows().filter((row) => row.orderLink === found.hash && sentInvoice(row));
    return rows().length ? { visitor, rows } : null;
  };
  // ask: get PayPal's live status first (through src/status.js: its 10-second cache and one round at a time).
  async function orderReply(found, { ask }) {
    const { visitor } = found;
    let checkFailed = false;
    if (ask && config.paypalConfigured && !FINAL.includes(found.rows()[0].invoiceStatus)) {
      const { failed } = await visitor.status.refresh();
      checkFailed = failed.some((f) => f.buyer === found.rows()[0]?.buyer);
    }
    const rows = found.rows(); // a New batch or Reset may have happened while PayPal answered
    if (!rows.length) return GONE;
    let qr = null;
    if (String(rows[0].invoiceStatus).startsWith("Paid") && !rows.every((row) => row.collected === true) && config.paypalConfigured) {
      try {
        if (!visitor.qrCodes.has(rows[0].invoiceId)) visitor.qrCodes.set(rows[0].invoiceId, (await paypal.qrCode(rows[0].invoiceId)).toString("base64"));
        qr = { png: visitor.qrCodes.get(rows[0].invoiceId) };
      } catch (err) {
        if (!(err instanceof PayPalError)) throw err;
        qr = { notice: "Your QR code couldn't be loaded just now. Please open this page again in a minute." };
      }
    }
    return { order: orderView(found.rows(), visitor.store.source(), visitor.store.menu(), { qr, checkFailed }) };
  }
  const tokenIn = (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = req.body?.token;
    if (typeof token === "string") return token;
    res.status(400).json({ error: 'Send { "token": "..." }.' });
    return null;
  };
  app.post("/api/order/view", limited("order"), async (req, res) => {
    const token = tokenIn(req, res);
    if (token === null) return;
    const found = orderFor(token);
    res.json(found ? await orderReply(found, { ask: true }) : GONE);
  });
  // "Looks right" or "Something's wrong" (+ a note). Saved on the buyer's rows for the seller; it never changes
  // an item, a quantity or a price. A later answer replaces the earlier one.
  app.post("/api/order/answer", limited("orderAnswer"), async (req, res) => {
    const token = tokenIn(req, res);
    if (token === null) return;
    const { answer, error } = readAnswer(req.body);
    if (error) return res.status(400).json({ error });
    const found = orderFor(token);
    if (!found) return res.json(GONE);
    found.visitor.store.replaceMany(found.rows().map((row) => ({ ...row, buyerAnswer: { ...answer, at: new Date(now()).toISOString() } })));
    res.json(await orderReply(found, { ask: false }));
  });

  // Everything after this belongs to one visitor. Each reply renews the cookie's 14 days, and says no-store
  // so a table can never sit in a shared cache. The health check above stays out, or every ping from Render
  // would be a new visitor. Secure follows the real connection: on Render req.secure reads X-Forwarded-Proto.
  app.use("/api", (req, res, next) => {
    const id = visitorIdFrom(req.headers.cookie) ?? newVisitorId();
    res.cookie(VISITOR_COOKIE, id, visitorCookie(req));
    res.set("Cache-Control", "no-store");
    req.visitorId = id;
    req.visitor = visitors.get(id);
    next();
  });

  // "Open on my phone", the laptop's side: a new one-time link for this visitor, and its QR.
  app.post("/api/pair/new", limited("pairNew"), (req, res) => {
    const link = `${req.protocol}://${req.get("host")}/pair#${pairing.create(req.visitorId)}`;
    res.json({ link, qr: pairQr(link), expiresInMs: PAIR_TTL_MS });
  });

  app.get("/api/state", (req, res) => {
    req.visitor.store.touch();
    res.json({
      ...table(req),
      aiMode: config.aiMode,
      aiCallsLeft: callsLeft(), // real calls left today, all models together (src/usage.js)
      paypalConfigured: config.paypalConfigured,
      geminiConfigured: config.geminiConfigured,
    });
  });

  // May the seller still change this buyer's order? Never once their invoice is sent (the invoice must keep
  // matching the table), never on a cancelled order, never while invoices are being sent.
  // -> null (go ahead) or [status, reason]. The page locks the drawer too, but the server is the guard.
  const sameBuyer = (a, b) => a.buyer.trim().toLowerCase() === b.buyer.trim().toLowerCase();
  function refuseChange({ store, invoicer }, row, id) {
    if (!row) return [404, `No order row "${id}".`];
    const own = store.rows().filter((other) => sameBuyer(other, row));
    if (own.some((other) => other.invoiceId)) return [400, LOCKED];
    if (own.some((other) => other.sendUnknown)) return [400, NO_ANSWER];
    if (!own.some((other) => other.orderStatus === "active") || row.orderStatus === "cancelled") return [400, CANCELLED];
    if (invoicer.isBusy()) return [409, SENDING];
    return null;
  }
  const refuse = (res, [status, error]) => res.status(status).json({ error });
  // Adding or removing an item is the seller's fix of the whole order: every active row of that buyer is
  // checked again (recalcRow), so the AI's (or the no-AI reader's) "please check" goes, while our own
  // checks stay (no item, a bad quantity, a price still to check).
  const recheckBuyer = (rows, row, menu) => rows.map((other) => (sameBuyer(other, row) && other.orderStatus === "active" ? recalcRow(other, menu) : other));

  // Save one edited cell (item, qty or date). The server recalculates the price, total and
  // unclear flag, so the page never does money maths. Bad input -> 400 with the reason.
  app.put("/api/orders/:id", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
    const menu = store.menu();
    const { changes, problems } = checkEdit(req.body, menu);
    if (problems.length) return res.status(400).json({ error: problems.join(" ") });
    const { keepMenuPrice, ...fields } = changes;
    if (fields.itemId !== undefined && fields.itemId !== row.itemId) {
      const twin = store.rows().find((other) => other.id !== row.id && sameBuyer(other, row) && other.orderStatus === "active" && other.itemId === fields.itemId);
      if (twin) return res.status(400).json({ error: `${row.buyer} already has ${twin.itemName}: change its quantity instead.` });
    }
    const next = { ...row, ...fields };
    if (keepMenuPrice) {
      if (!row.priceCheck || row.priceCheck.kept) return res.status(400).json({ error: "This item has no price to check." });
      next.priceCheck = { ...row.priceCheck, kept: true }; // the invoice uses the menu price, as always
    }
    const updated = store.replace(recalcRow(next, menu));
    const rows = store.rows();
    res.json({ row: updated, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu), texts: textsOf(req) });
  });

  // Add an item to a buyer's order (the drawer's "Add item"): { itemId, qty } only. The price and total come
  // from the menu, the day and pickup/delivery from the buyer's order. The new row sits right after the
  // buyer's other rows. The reply is the whole table, so the cards, kitchen list and Copy texts follow.
  app.post("/api/buyers/:id/items", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const extra = Object.keys(body).filter((field) => field !== "itemId" && field !== "qty");
    if (extra.length) return res.status(400).json({ error: `"${extra[0]}" can't be set: send only itemId and qty. Prices come from the menu.` });
    if (body.itemId === undefined || body.qty === undefined) return res.status(400).json({ error: 'Send { "itemId": "a menu item", "qty": 1 }.' });
    const menu = store.menu();
    const { problems } = checkEdit({ itemId: body.itemId, qty: body.qty }, menu);
    if (problems.length) return res.status(400).json({ error: problems.join(" ") });

    const rows = store.rows();
    const own = rows.filter((other) => sameBuyer(other, row) && other.orderStatus === "active");
    const item = menu.items.find((it) => it.id === body.itemId);
    if (own.some((other) => other.itemId === item.id)) {
      return res.status(400).json({ error: `${row.buyer} already has ${item.name}: change its quantity instead.` });
    }
    const base = own[0];
    const id = `r${Math.max(0, ...rows.map((other) => Number(String(other.id).slice(1)) || 0)) + 1}`;
    const added = recalcRow({
      ...base, id, itemId: item.id, qty: body.qty, priceCheck: null,
      invoiceId: null, invoiceNumber: null, payerLink: null, invoiceStatus: "Draft",
    }, menu);
    const at = rows.findLastIndex((other) => sameBuyer(other, row)) + 1;
    store.setRows(recheckBuyer([...rows.slice(0, at), added, ...rows.slice(at)], row, menu));
    res.json(table(req));
  });

  // Remove one item (the drawer's "Remove item"). The buyer's last item can't just disappear: the reply
  // is 409 { lastItem: true }, and the page asks "Cancel this buyer's order?" (the route below).
  app.delete("/api/orders/:id", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
    const rows = store.rows();
    if (rows.filter((other) => sameBuyer(other, row) && other.orderStatus === "active").length === 1) {
      return res.status(409).json({ error: `This is ${row.buyer}'s last item. Cancel the order instead.`, lastItem: true });
    }
    store.setRows(recheckBuyer(rows.filter((other) => other.id !== row.id), row, store.menu()));
    res.json(table(req));
  });

  // Cancel a buyer's order (after "Cancel this buyer's order?"): their rows stay, greyed out as cancelled,
  // like an order the buyer cancelled in the chat. No undo button: reading the chats again starts over.
  app.post("/api/buyers/:id/cancel", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
    store.setRows(store.rows().map((other) => (sameBuyer(other, row) && other.orderStatus === "active"
      ? { ...other, orderStatus: "cancelled", unclear: false, reason: "" } : other)));
    res.json(table(req));
  });

  // "Send anyway" (the drawer): the seller says this buyer's second invoice today is a real second order. It
  // only clears that check; the invoice still goes out with Send invoices, and every other check stays.
  app.post("/api/buyers/:id/send-anyway", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
    const waiting = (other) => sameBuyer(other, row) && other.orderStatus === "active" && other.earlierInvoice && !other.earlierInvoice.kept;
    if (!store.rows().some(waiting)) return res.status(400).json({ error: `${row.buyer} has no earlier invoice to check.` });
    store.setRows(store.rows().map((other) => (waiting(other) ? keepEarlierInvoice(other) : other)));
    res.json(table(req));
  });

  // Every read, with or without the AI: our checks, the rows, and the double-invoice guard between batches.
  // The menu is the visitor's, taken once when the read starts (the menu can't change while a read runs).
  const readRows = (store, menu, orders, messages, chatDate) => markEarlierInvoices(toRows(checkOrders(orders, messages, menu), menu), store.batches(), chatDate, menu);

  // Chat text + Chat date -> new order rows (they replace the current ones). Every AI reply goes through
  // our checks and toRows(), so bad AI data becomes unclear rows, never dropped (PLAN.md Section 5).
  // Anything the seller can fix by pasting again (too long, mock mode doesn't know the chats, an
  // unreadable AI answer) is a { notice } with status 200: friendly words, not an error, rows unchanged.
  // Step 10: a notice about the AI (busy, too slow, used up, refused, unreadable) also says
  // readWithoutAi: true, so the page offers "Read without AI"; { withoutAi: true } then reads the chats with
  // src/fallback-parse.js (no AI call) through the same checks. Never automatic: the seller chooses.
  app.post("/api/parse", limited("parse", { readWithoutAi: true }), async (req, res) => {
    const { visitor } = req;
    const { store, invoicer } = visitor;
    const { text, chatDate, withoutAi = false } = req.body ?? {};
    if (typeof text !== "string" || typeof chatDate !== "string") {
      return res.status(400).json({ error: 'Send { "text": "the chat messages", "chatDate": "YYYY-MM-DD" }.' });
    }
    if (typeof withoutAi !== "boolean") return res.status(400).json({ error: "withoutAi must be true or false." });
    if (visitor.reading) return res.json({ notice: READING });
    if (invoicer.isBusy()) return res.json({ notice: SENDING });
    // Reading replaces every row: never once an invoice exists (its link would be lost). New batch first.
    if (store.hasInvoices()) return res.json({ notice: INVOICED });
    const { messages, notice } = readPaste(text, chatDate);
    if (notice) return res.json({ notice });
    const menu = store.menu();
    if (withoutAi) {
      const rows = readRows(store, menu, fallbackParse(messages, menu), messages, chatDate);
      store.setAll(rows, { text, chatDate, messages: messages.length, reader: "fallback" });
      return res.json(table(req));
    }

    visitor.reading = true;
    visitor.readingStage = "reading";
    visitor.readingMessages = messages.length;
    let rows;
    try {
      const validate = (orders) => readRows(store, menu, orders, messages, chatDate);
      const reply = await ai.parse({ text, chatDate, messages, menu, validate, onStage: (stage) => (visitor.readingStage = stage) });
      if (reply.notice) return res.json({ notice: reply.notice, readWithoutAi: true });
      rows = readRows(store, menu, reply.orders, messages, chatDate);
    } catch (err) {
      log(`Warning: the AI reply could not be read (${err.message}).`);
      return res.json({ notice: UNREADABLE, readWithoutAi: true });
    } finally {
      visitor.reading = false;
      visitor.readingStage = null;
      visitor.readingMessages = null;
    }
    store.setAll(rows, { text, chatDate, messages: messages.length });
    res.json(table(req));
  });

  // While Read orders waits, the page asks this about once a second: which words to show ("Reading the
  // chats..." or "The AI is busy, trying the backup..."), how many messages are being read (the loading card,
  // 6 Nov) and how many AI calls are left. Never calls the AI.
  app.get("/api/parse/progress", (req, res) => {
    const { reading, readingStage, readingMessages } = req.visitor;
    res.json({ reading, stage: readingStage, messages: readingMessages, aiCallsLeft: callsLeft() });
  });

  // Send invoices: one PayPal sandbox invoice per clear buyer that has none yet (src/invoices.js has the
  // guards). { buyer } invoices just that buyer. Missing keys -> 503 with the message sent on purpose,
  // because the error handler hides every 5xx message. Per-buyer PayPal problems come back in "failed".
  app.post("/api/invoices", async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const { buyer } = req.body ?? {};
    if (buyer !== undefined && typeof buyer !== "string") return res.status(400).json({ error: 'Send {} for every buyer, or { "buyer": "Lina" }.' });
    const { store, invoicer, status } = req.visitor;
    if (req.visitor.reading) return res.json({ notice: READING });
    let result;
    try {
      result = await invoicer.sendInvoices({ buyer, spend: () => limiter.take("invoices", req.ip) });
    } catch (err) {
      if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    if (result.sent.length) status.markFresh(); // PayPal just told us these statuses
    const { limitedMs, ...sentResult } = result;
    if (limitedMs !== undefined) log(`Rate limit: too many invoices from one visitor; asked to wait ${Math.ceil(limitedMs / 1000)} s.`);
    res.json({ ...sentResult, ...(limitedMs !== undefined && { notice: slowDown(limitedMs), rateLimited: true }), ...table(req) });
  });

  // Refresh status (the button, and the page's polling every 20 s): PayPal's status for every open
  // invoice, saved. 10-second cache + one shared round (src/status.js), so many tabs can't flood PayPal.
  app.post("/api/invoices/refresh", limited("refresh"), async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const { store, status } = req.visitor;
    res.json({ ...(await status.refresh()), ...table(req) });
  });

  // Record a cash / bank-transfer payment: the page sends ONLY the method; the amount is the saved
  // invoice's full total (src/payments.js). Refusals (already paid, part paid, a second click) are 4xx
  // with the reason; a PayPal problem comes back as { failed } so its words reach the seller.
  app.post("/api/invoices/:id/payment", limited("payment"), async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const body = req.body ?? {};
    if (Object.hasOwn(body, "amount")) {
      return res.status(400).json({ error: "Send only the method: the amount always comes from the invoice." });
    }
    const { store, invoicer, payments } = req.visitor;
    if (invoicer.isBusy()) return res.status(409).json({ error: SENDING });
    try {
      const recorded = await payments.record(req.params.id, body.method);
      res.json({ recorded, ...table(req) });
    } catch (err) {
      if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
      if (err instanceof PayPalError) return res.json({ failed: err.message, ...table(req) });
      throw err;
    }
  });

  // Pickup scan (Step 10c, src/pickup.js). Only a wrongly shaped request is a 400: everything a seller can
  // meet (a stranger's QR, not in this table, not paid yet) is a { notice }, so no red console line.
  const readRef = (req, res) => {
    const { invoiceId, undo } = req.body ?? {};
    const ok = typeof invoiceId === "string" && (undo === undefined || typeof undo === "boolean");
    if (!ok) res.status(400).json({ error: 'Send { "invoiceId": "INV2-..." }.' });
    return ok;
  };
  const pickupReply = (res, req, reply) => res.json(reply.notice ? reply : { ...reply, ...table(req) });

  // The scanned or typed invoice: buyer, items, total and paid or not, from PayPal's live status.
  app.post("/api/pickup/check", limited("pickup"), async (req, res) => {
    if (!readRef(req, res)) return;
    if (!config.paypalConfigured) return res.json({ notice: NOT_CONFIGURED });
    pickupReply(res, req, await req.visitor.pickup.check(req.body.invoiceId));
  });

  // "Collected" (or { undo: true }): our own status, never sent to PayPal, only for a paid invoice.
  app.post("/api/pickup/collected", (req, res) => {
    if (!readRef(req, res)) return;
    pickupReply(res, req, req.visitor.pickup.collected(req.body.invoiceId, { undo: req.body.undo }));
  });

  // The buyer panel (Step 7, #1 "Show your work"): the AI's note + the buyer's own messages with the
  // parts that mattered marked (src/panel.js), and which invoice (if sent) has a QR code. No AI, no PayPal.
  // A row the table no longer has (the free server forgot the table while the tab stayed open) is a
  // { notice }, like the other "table was cleared" cases, so a click on a row never logs a red line.
  app.get("/api/buyers/:id/panel", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    if (!row) return res.json({ notice: ORDER_GONE });
    const rows = store.rows().filter((other) => other.buyer.trim().toLowerCase() === row.buyer.trim().toLowerCase());
    const sent = rows.find((other) => other.invoiceId && other.payerLink && other.invoiceStatus !== "Draft");
    res.json({ ...buyerPanel(rows, store.source(), store.menu()), qrInvoiceId: sent?.invoiceId ?? null });
  });

  // The invoice's QR code from PayPal (#3b), as Base64 PNG in JSON so the page can show it (and a PayPal
  // problem is friendly words, not a red console error). Only for invoices in this table that were sent.
  // A QR code never changes, so each is asked for once and kept in memory.
  app.get("/api/invoices/:id/qr", async (req, res) => {
    const { store, qrCodes } = req.visitor;
    const row = store.rows().find((other) => other.invoiceId === req.params.id);
    if (!row || !row.payerLink || row.invoiceStatus === "Draft") {
      return res.status(404).json({ error: "No sent invoice with that id in this table." });
    }
    if (!config.paypalConfigured) return res.json({ notice: NOT_CONFIGURED });
    try {
      if (!qrCodes.has(row.invoiceId)) qrCodes.set(row.invoiceId, (await paypal.qrCode(row.invoiceId)).toString("base64"));
      res.json({ invoiceId: row.invoiceId, png: qrCodes.get(row.invoiceId), fileName: qrFileName(row.buyer) });
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      res.json({ notice: `The QR code could not be loaded (${err.message})` });
    }
  });

  // ---- My menu (7 Nov): the visitor's own items, names and prices (src/menu.js has the checks) ----
  // Refused while this batch has an invoice (or a send with no answer): the invoice, the buyer's page and the
  // table must keep matching the menu they were made from, so the seller starts a New batch first. Also never
  // while a read runs (it uses the menu it started with) or while invoices or a payment are on their way.
  // The page locks its buttons too, but the server is the guard.
  function menuRefused(req, res) {
    const { store, invoicer, payments, reading } = req.visitor;
    const refused = store.hasInvoices() ? { error: MENU_LOCKED, locked: true }
      : reading ? { error: READING }
      : invoicer.isBusy() || payments.isBusy() ? { error: SENDING } : null;
    if (refused) res.status(409).json(refused);
    return Boolean(refused);
  }
  // The new menu, and every row not yet invoiced re-priced from it, saved together. The reply is the whole table.
  function saveMenu(req, res, menu) {
    const { store } = req.visitor;
    store.setMenu(menu, repriceRows(store.rows(), menu));
    res.json(table(req));
  }
  const noItem = (res, id) => res.status(404).json({ error: `No item ${JSON.stringify(id)} on your menu.` });
  // A random id, never one the menu had: a row of a removed item can't pick up a new item later.
  const newItemId = (menu) => () => {
    let id;
    do id = `item_${randomBytes(4).toString("hex")}`; while (menu.items.some((item) => item.id === id));
    return id;
  };

  app.post("/api/menu/items", (req, res) => {
    if (menuRefused(req, res)) return;
    const current = req.visitor.store.menu();
    const { menu, error } = addMenuItem(current, req.body, { newId: newItemId(current) });
    if (error) return res.status(400).json({ error });
    saveMenu(req, res, menu);
  });

  app.put("/api/menu/items/:id", (req, res) => {
    if (menuRefused(req, res)) return;
    const { menu, error, missing } = editMenuItem(req.visitor.store.menu(), req.params.id, req.body);
    if (missing) return noItem(res, req.params.id);
    if (error) return res.status(400).json({ error });
    saveMenu(req, res, menu);
  });

  app.delete("/api/menu/items/:id", (req, res) => {
    if (menuRefused(req, res)) return;
    const { menu, error, missing } = removeMenuItem(req.visitor.store.menu(), req.params.id);
    if (missing) return noItem(res, req.params.id);
    if (error) return res.status(400).json({ error });
    saveMenu(req, res, menu);
  });

  // Load demo / Try the demo (after "This replaces your menu with the demo bakery menu." when it was changed).
  app.post("/api/menu/demo", (req, res) => {
    if (menuRefused(req, res)) return;
    saveMenu(req, res, demoMenu);
  });

  // Load demo (stretch #2): the demo chats + their Chat date, to fill the chat box. It does NOT read them:
  // the judge clicks Read orders to see that step (the saved Gemini reply, 0 AI calls). Same batch rule
  // as Read orders: once invoices are sent, no new reading until New batch.
  app.get("/api/demo", (req, res) => {
    if (req.visitor.store.hasInvoices()) return res.json({ notice: INVOICED });
    res.json(demoSource());
  });

  // Reset demo: clear this visitor's orders so their demo can start over (0 AI calls, 0 PayPal calls). It
  // never deletes or cancels anything in PayPal; sent invoices are kept in the visitor's file first.
  app.post("/api/reset", (req, res) => {
    const { store, invoicer, payments, reading } = req.visitor;
    if (invoicer.isBusy() || payments.isBusy()) return res.json({ notice: SENDING });
    if (reading) return res.json({ notice: READING });
    store.reset();
    res.json(table(req));
  });

  // New batch: keep this batch (rows + invoice links) in the visitor's file and start an empty table.
  app.post("/api/new-batch", (req, res) => {
    const { store, invoicer, payments, reading } = req.visitor;
    if (invoicer.isBusy() || payments.isBusy()) return res.json({ notice: SENDING });
    if (reading) return res.json({ notice: READING });
    store.newBatch();
    res.json(table(req));
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use(errorHandler(log));
  return app;
}
