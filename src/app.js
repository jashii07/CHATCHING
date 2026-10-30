// Builds the Express app: middleware, API routes and the static page.
// server.js starts it; the tests start it on a free port.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { buyerGroups, checkEdit, checkMenu, recalcRow, summary, toRows, totals } from "./orders.js";
import { createStore, demoSource } from "./store.js";
import { createAi } from "./ai.js";
import { readPaste } from "./paste.js";
import { checkOrders } from "./validate.js";
import { createPayPal, NOT_CONFIGURED, PayPalError } from "./paypal.js";
import { createPaymentRecorder } from "./payments.js";
import { createInvoicer } from "./invoices.js";
import { createStatusChecker } from "./status.js";
import { buyerPanel } from "./panel.js";
import { kitchenList } from "./kitchen.js";

const UNREADABLE = "The AI's answer could not be read, so your orders were not changed. Please try again.";
const INVOICED = "Invoices already sent for these orders. Start a new batch to read again.";
const SENDING = "Invoices are being sent right now. Please wait for that to finish.";
const READING = "Already reading orders. Please wait for that to finish.";

const MENU_FILE = new URL("../data/menu.json", import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// The current rows live here (git-ignored). Tests pass their own temporary file.
const STORE_FILE = fileURLToPath(new URL("../data/runtime/orders.json", import.meta.url));

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
  storeFile = STORE_FILE,
  ai = createAi({ mode: config.aiMode, apiKey: config.gemini.apiKey, log }),
  paypal = createPayPal({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypalBaseUrl }),
  now = Date.now, // the clock for the status cache (tests pass their own)
} = {}) {
  const menu = loadMenu();
  const store = createStore({ file: storeFile, menu, log });
  const invoicer = createInvoicer({ store, paypal, menu, log });
  const status = createStatusChecker({ store, paypal, now, log });
  const payments = createPaymentRecorder({ store, paypal, menu, now });
  const qrCodes = new Map(); // invoice id -> Base64 PNG (a QR code never changes)
  let reading = false; // never more than one parse at a time (it can cost real AI calls)
  let readingStage = null; // "reading" or "backup" while a parse runs: the page's loading words (Step 9)
  const callsLeft = () => ai.callsLeft?.() ?? null; // a test's own fake AI may have no counter

  // What the table, cards, slim bar and kitchen list need: the same shape after every change.
  const table = () => {
    const rows = store.rows();
    return { orders: rows, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu), source: store.source(), batch: store.batch() };
  };
  const app = express();
  app.disable("x-powered-by"); // don't advertise which server software we run

  // One log line per API request: method, path, status, time in ms.
  app.use("/api", (req, res, next) => {
    const start = performance.now();
    res.on("finish", () => {
      log(`${req.method} ${pathOf(req)} ${res.statusCode} ${Math.round(performance.now() - start)}ms`);
    });
    next();
  });

  // Reads JSON request bodies (the chat paste later). 100 KB is plenty for ~50 messages.
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/state", (req, res) => {
    res.json({
      menu,
      ...table(),
      aiMode: config.aiMode,
      aiCallsLeft: callsLeft(), // real calls left today, all models together (src/usage.js)
      paypalConfigured: config.paypalConfigured,
      geminiConfigured: config.geminiConfigured,
    });
  });

  // Save one edited cell (item, qty or date). The server recalculates the price, total and
  // unclear flag, so the page never does money maths. Bad input -> 400 with the reason.
  app.put("/api/orders/:id", (req, res) => {
    const row = store.find(req.params.id);
    if (!row) return res.status(404).json({ error: `No order row "${req.params.id}".` });
    if (row.orderStatus === "cancelled") {
      return res.status(400).json({ error: "This order is cancelled, so it can't be edited." });
    }
    // An invoice can't change after it is sent: editing the row would make it disagree with PayPal.
    const sameBuyer = (other) => other.buyer.trim().toLowerCase() === row.buyer.trim().toLowerCase();
    if (store.rows().some((other) => sameBuyer(other) && other.invoiceId)) {
      return res.status(400).json({ error: `${row.buyer} is already invoiced, so this order can't be changed.` });
    }
    if (invoicer.isBusy()) return res.status(409).json({ error: SENDING });
    const { changes, problems } = checkEdit(req.body, menu);
    if (problems.length) return res.status(400).json({ error: problems.join(" ") });
    const { keepMenuPrice, ...fields } = changes;
    const next = { ...row, ...fields };
    if (keepMenuPrice) {
      if (!row.priceCheck || row.priceCheck.kept) return res.status(400).json({ error: "This item has no price to check." });
      next.priceCheck = { ...row.priceCheck, kept: true }; // the invoice uses the menu price, as always
    }
    const updated = store.replace(recalcRow(next, menu));
    const rows = store.rows();
    res.json({ row: updated, totals: totals(rows), summary: summary(rows), groups: buyerGroups(rows), kitchen: kitchenList(rows, menu) });
  });

  // Chat text + Chat date -> new order rows (they replace the current ones). Every AI reply goes through
  // our checks and toRows(), so bad AI data becomes unclear rows, never dropped (PLAN.md Section 5).
  // Anything the seller can fix by pasting again (too long, mock mode doesn't know the chats, an
  // unreadable AI answer) is a { notice } with status 200: friendly words, not an error, rows unchanged.
  app.post("/api/parse", async (req, res) => {
    const { text, chatDate } = req.body ?? {};
    if (typeof text !== "string" || typeof chatDate !== "string") {
      return res.status(400).json({ error: 'Send { "text": "the chat messages", "chatDate": "YYYY-MM-DD" }.' });
    }
    if (reading) return res.json({ notice: READING });
    if (invoicer.isBusy()) return res.json({ notice: SENDING });
    // Reading replaces every row: never once an invoice exists (its link would be lost). New batch first.
    if (store.hasInvoices()) return res.json({ notice: INVOICED });
    const { messages, notice } = readPaste(text, chatDate);
    if (notice) return res.json({ notice });

    reading = true;
    readingStage = "reading";
    let rows;
    try {
      const reply = await ai.parse({ text, chatDate, messages, menu, onStage: (stage) => (readingStage = stage) });
      if (reply.notice) return res.json({ notice: reply.notice });
      rows = toRows(checkOrders(reply.orders, messages), menu);
    } catch (err) {
      log(`Warning: the AI reply could not be read (${err.message}).`);
      return res.json({ notice: UNREADABLE });
    } finally {
      reading = false;
      readingStage = null;
    }
    store.setAll(rows, { text, chatDate, messages: messages.length });
    res.json(table());
  });

  // While Read orders waits, the page asks this about once a second: which words to show ("Reading the
  // chats..." or "The AI is busy, trying the backup...") and how many AI calls are left. Never calls the AI.
  app.get("/api/parse/progress", (req, res) => {
    res.json({ reading, stage: readingStage, aiCallsLeft: callsLeft() });
  });

  // Send invoices: one PayPal sandbox invoice per clear buyer that has none yet (src/invoices.js has the
  // guards). { buyer } invoices just that buyer. Missing keys -> 503 with the message sent on purpose,
  // because the error handler hides every 5xx message. Per-buyer PayPal problems come back in "failed".
  app.post("/api/invoices", async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const { buyer } = req.body ?? {};
    if (buyer !== undefined && typeof buyer !== "string") return res.status(400).json({ error: 'Send {} for every buyer, or { "buyer": "Lina" }.' });
    if (reading) return res.json({ notice: READING });
    let result;
    try {
      result = await invoicer.sendInvoices({ buyer });
    } catch (err) {
      if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    if (result.sent.length) status.markFresh(); // PayPal just told us these statuses
    res.json({ ...result, ...table() });
  });

  // Refresh status (the button, and the page's polling every 20 s): PayPal's status for every open
  // invoice, saved. 10-second cache + one shared round (src/status.js), so many tabs can't flood PayPal.
  app.post("/api/invoices/refresh", async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    res.json({ ...(await status.refresh()), ...table() });
  });

  // Record a cash / bank-transfer payment: the page sends ONLY the method; the amount is the saved
  // invoice's full total (src/payments.js). Refusals (already paid, part paid, a second click) are 4xx
  // with the reason; a PayPal problem comes back as { failed } so its words reach the seller.
  app.post("/api/invoices/:id/payment", async (req, res) => {
    if (!config.paypalConfigured) return res.status(503).json({ error: NOT_CONFIGURED });
    const body = req.body ?? {};
    if (Object.hasOwn(body, "amount")) {
      return res.status(400).json({ error: "Send only the method: the amount always comes from the invoice." });
    }
    if (invoicer.isBusy()) return res.status(409).json({ error: SENDING });
    try {
      const recorded = await payments.record(req.params.id, body.method);
      res.json({ recorded, ...table() });
    } catch (err) {
      if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
      if (err instanceof PayPalError) return res.json({ failed: err.message, ...table() });
      throw err;
    }
  });

  // The buyer panel (Step 7, #1 "Show your work"): the AI's note + the buyer's own messages with the
  // parts that mattered marked (src/panel.js), and which invoice (if sent) has a QR code. No AI, no PayPal.
  app.get("/api/buyers/:id/panel", (req, res) => {
    const row = store.find(req.params.id);
    if (!row) return res.status(404).json({ error: `No order row "${req.params.id}".` });
    const rows = store.rows().filter((other) => other.buyer.trim().toLowerCase() === row.buyer.trim().toLowerCase());
    const sent = rows.find((other) => other.invoiceId && other.payerLink && other.invoiceStatus !== "Draft");
    res.json({ ...buyerPanel(rows, store.source(), menu), qrInvoiceId: sent?.invoiceId ?? null });
  });

  // The invoice's QR code from PayPal (#3b), as Base64 PNG in JSON so the page can show it (and a PayPal
  // problem is friendly words, not a red console error). Only for invoices in this table that were sent.
  // A QR code never changes, so each is asked for once and kept in memory.
  app.get("/api/invoices/:id/qr", async (req, res) => {
    const row = store.rows().find((other) => other.invoiceId === req.params.id);
    if (!row || !row.payerLink || row.invoiceStatus === "Draft") {
      return res.status(404).json({ error: "No sent invoice with that id in this table." });
    }
    if (!config.paypalConfigured) return res.json({ notice: NOT_CONFIGURED });
    try {
      if (!qrCodes.has(row.invoiceId)) qrCodes.set(row.invoiceId, (await paypal.qrCode(row.invoiceId)).toString("base64"));
      res.json({ invoiceId: row.invoiceId, png: qrCodes.get(row.invoiceId) });
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      res.json({ notice: `The QR code could not be loaded (${err.message})` });
    }
  });

  // Load demo (stretch #2): the demo chats + their Chat date, to fill the chat box. It does NOT read them:
  // the judge clicks Read orders to see that step (the saved Gemini reply, 0 AI calls). Same batch rule
  // as Read orders: once invoices are sent, no new reading until New batch.
  app.get("/api/demo", (req, res) => {
    if (store.hasInvoices()) return res.json({ notice: INVOICED });
    res.json(demoSource());
  });

  // Reset demo: clear the saved orders so the demo can start over (0 AI calls, 0 PayPal calls). It never
  // deletes or cancels anything in PayPal; sent invoices are saved to batches/ first.
  app.post("/api/reset", (req, res) => {
    if (invoicer.isBusy() || payments.isBusy()) return res.json({ notice: SENDING });
    if (reading) return res.json({ notice: READING });
    store.reset();
    res.json(table());
  });

  // New batch: save this batch (rows + invoice links) to data/runtime/batches/ and start an empty table.
  app.post("/api/new-batch", (req, res) => {
    if (invoicer.isBusy() || payments.isBusy()) return res.json({ notice: SENDING });
    if (reading) return res.json({ notice: READING });
    store.newBatch();
    res.json(table());
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use(errorHandler(log));
  return app;
}
