// Builds the Express app: middleware, API routes and the static page.
// server.js starts it; the tests start it on a free port.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { buyerGroups, checkEdit, checkMenu, keepEarlierInvoice, markEarlierInvoices, recalcRow, summary, toRows, totals } from "./orders.js";
import { createStore, demoSource } from "./store.js";
import { MAX_AGE_MS, VISITOR_COOKIE, createVisitors, newVisitorId, visitorIdFrom } from "./visitors.js";
import { createAi } from "./ai.js";
import { readPaste } from "./paste.js";
import { checkOrders } from "./validate.js";
import { fallbackParse } from "./fallback-parse.js";
import { createPayPal, NOT_CONFIGURED, PayPalError } from "./paypal.js";
import { createPaymentRecorder } from "./payments.js";
import { createInvoicer } from "./invoices.js";
import { createStatusChecker } from "./status.js";
import { createPickup, qrFileName } from "./pickup.js";
import { PAIR_EXPIRED, PAIR_TTL_MS, createPairing, pairQr } from "./pairing.js";
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

const MENU_FILE = new URL("../data/menu.json", import.meta.url);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// Each visitor's rows live here (git-ignored). Tests pass their own temporary folder.
const VISITORS_DIR = fileURLToPath(new URL("../data/runtime/visitors/", import.meta.url));

const pathOf = (req) => req.originalUrl.split("?")[0];

function loadMenu() {
  let menu;
  try {
    menu = JSON.parse(readFileSync(MENU_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Could not read data/menu.json: ${err.message}`);
  }
  const problems = checkMenu(menu);
  if (problems.length) throw new Error(`data/menu.json has problems: ${problems.join(" ")}`);
  return menu;
}

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
  const menu = loadMenu();
  // One visitor's table and everything that guards it. The AI, its daily counter, PayPal and the rate limits
  // are shared by all visitors; the rows, the locks and the batch rule are not (src/visitors.js has the why).
  const visitors = createVisitors({
    dir: visitorsDir,
    now,
    open({ file, onNewFile }) {
      const store = createStore({ file, log, onNewFile });
      const invoicer = createInvoicer({ store, paypal, menu, log });
      const status = createStatusChecker({ store, paypal, now, log });
      const payments = createPaymentRecorder({ store, paypal, menu, now });
      const pickup = createPickup({ store, status, menu });
      const visitor = {
        store, invoicer, status, payments, pickup,
        qrCodes: new Map(), // invoice id -> Base64 PNG (a QR code never changes)
        reading: false, // one parse at a time per visitor (it can cost real AI calls)
        readingStage: null, // "reading" or "backup" while a parse runs: the page's loading words (Step 9)
        isBusy: () => visitor.reading || invoicer.isBusy() || payments.isBusy() || status.isBusy(),
      };
      return visitor;
    },
  });
  const pairing = createPairing({ now }); // "Open on my phone": shared by all visitors, in memory only
  const callsLeft = () => ai.callsLeft?.() ?? null; // a test's own fake AI may have no counter

  // What the table, cards, slim bar, kitchen list and ready-to-send texts need: the same shape after every change.
  const table = (store) => {
    const rows = store.rows();
    return { orders: rows, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu), texts: buyerMessages(rows, store.source(), menu), source: store.source(), batch: store.batch() };
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
  app.get("/api/health", (req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // "Open on my phone", the phone's side. Above the visitor step on purpose: a phone that isn't paired yet gets
  // no new visitor from this route, and a refused link leaves its cookie alone. Wrong, used and expired all get
  // the same friendly words (200, no red console line). The id goes in the cookie only, never in a body or a URL.
  const visitorCookie = (req) => ({ httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: MAX_AGE_MS });
  app.get("/pair", (req, res) => res.sendFile("pair.html", { root: PUBLIC_DIR }));
  app.post("/api/pair/open", limited("pairOpen"), (req, res) => {
    const code = req.body?.code;
    if (typeof code !== "string") return res.status(400).json({ error: 'Send { "code": "..." }.' });
    const id = pairing.redeem(code);
    if (!id) return res.json({ notice: PAIR_EXPIRED });
    res.cookie(VISITOR_COOKIE, id, visitorCookie(req));
    res.json({ paired: true });
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
      menu,
      ...table(req.visitor.store),
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
  const recheckBuyer = (rows, row) => rows.map((other) => (sameBuyer(other, row) && other.orderStatus === "active" ? recalcRow(other, menu) : other));

  // Save one edited cell (item, qty or date). The server recalculates the price, total and
  // unclear flag, so the page never does money maths. Bad input -> 400 with the reason.
  app.put("/api/orders/:id", (req, res) => {
    const { store } = req.visitor;
    const row = store.find(req.params.id);
    const refused = refuseChange(req.visitor, row, req.params.id);
    if (refused) return refuse(res, refused);
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
    res.json({ row: updated, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu), texts: buyerMessages(rows, store.source(), menu) });
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
    store.setRows(recheckBuyer([...rows.slice(0, at), added, ...rows.slice(at)], row));
    res.json(table(store));
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
    store.setRows(recheckBuyer(rows.filter((other) => other.id !== row.id), row));
    res.json(table(store));
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
    res.json(table(store));
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
    res.json(table(store));
  });

  // Every read, with or without the AI: our checks, the rows, and the double-invoice guard between batches.
  const readRows = (store, orders, messages, chatDate) => markEarlierInvoices(toRows(checkOrders(orders, messages, menu), menu), store.batches(), chatDate, menu);

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
    if (withoutAi) {
      const rows = readRows(store, fallbackParse(messages, menu), messages, chatDate);
      store.setAll(rows, { text, chatDate, messages: messages.length, reader: "fallback" });
      return res.json(table(store));
    }

    visitor.reading = true;
    visitor.readingStage = "reading";
    let rows;
    try {
      const validate = (orders) => readRows(store, orders, messages, chatDate);
      const reply = await ai.parse({ text, chatDate, messages, menu, validate, onStage: (stage) => (visitor.readingStage = stage) });
      if (reply.notice) return res.json({ notice: reply.notice, readWithoutAi: true });
      rows = readRows(store, reply.orders, messages, chatDate);
    } catch (err) {
      log(`Warning: the AI reply could not be read (${err.message}).`);
      return res.json({ notice: UNREADABLE, readWithoutAi: true });
    } finally {
      visitor.reading = false;
      visitor.readingStage = null;
    }
    store.setAll(rows, { text, chatDate, messages: messages.length });
    res.json(table(store));
  });

  // While Read orders waits, the page asks this about once a second: which words to show ("Reading the
  // chats..." or "The AI is busy, trying the backup...") and how many AI calls are left. Never calls the AI.
  app.get("/api/parse/progress", (req, res) => {
    res.json({ reading: req.visitor.reading, stage: req.visitor.readingStage, aiCallsLeft: callsLeft() });
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
    res.json({ ...sentResult, ...(limitedMs !== undefined && { notice: slowDown(limitedMs), rateLimited: true }), ...table(store) });
  });

  // Refresh status (the button, and the page's polling every 20 s): PayPal's status for every open
  // invoice, saved. 10-second cache + one shared round (src/status.js), so many tabs can't flood PayPal.
  app.post("/api/invoices/refresh", limited("refresh"), async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const { store, status } = req.visitor;
    res.json({ ...(await status.refresh()), ...table(store) });
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
      res.json({ recorded, ...table(store) });
    } catch (err) {
      if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
      if (err instanceof PayPalError) return res.json({ failed: err.message, ...table(store) });
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
  const pickupReply = (res, { store }, reply) => res.json(reply.notice ? reply : { ...reply, ...table(store) });

  // The scanned or typed invoice: buyer, items, total and paid or not, from PayPal's live status.
  app.post("/api/pickup/check", limited("pickup"), async (req, res) => {
    if (!readRef(req, res)) return;
    if (!config.paypalConfigured) return res.json({ notice: NOT_CONFIGURED });
    pickupReply(res, req.visitor, await req.visitor.pickup.check(req.body.invoiceId));
  });

  // "Collected" (or { undo: true }): our own status, never sent to PayPal, only for a paid invoice.
  app.post("/api/pickup/collected", (req, res) => {
    if (!readRef(req, res)) return;
    pickupReply(res, req.visitor, req.visitor.pickup.collected(req.body.invoiceId, { undo: req.body.undo }));
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
    res.json({ ...buyerPanel(rows, store.source(), menu), qrInvoiceId: sent?.invoiceId ?? null });
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
    res.json(table(store));
  });

  // New batch: keep this batch (rows + invoice links) in the visitor's file and start an empty table.
  app.post("/api/new-batch", (req, res) => {
    const { store, invoicer, payments, reading } = req.visitor;
    if (invoicer.isBusy() || payments.isBusy()) return res.json({ notice: SENDING });
    if (reading) return res.json({ notice: READING });
    store.newBatch();
    res.json(table(store));
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use(errorHandler(log));
  return app;
}
