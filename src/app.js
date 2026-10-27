// Builds the Express app: middleware, API routes and the static page.
// server.js starts it; the tests start it on a free port.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { buyerGroups, checkEdit, checkMenu, recalcRow, summary, totals } from "./orders.js";
import { createStore } from "./store.js";

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

export function createApp(config, { log = console.log, storeFile = STORE_FILE } = {}) {
  const menu = loadMenu();
  const store = createStore({ file: storeFile, menu, log });
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
      orders: store.rows(),
      totals: totals(store.rows()),
      summary: summary(store.rows()),
      groups: buyerGroups(store.rows()),
      source: store.source(),
      aiMode: config.aiMode,
      aiCallsLeft: 20, // placeholder until the daily counter (PLAN.md Step 9)
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
    const { changes, problems } = checkEdit(req.body, menu);
    if (problems.length) return res.status(400).json({ error: problems.join(" ") });
    const updated = store.replace(recalcRow({ ...row, ...changes }, menu));
    res.json({ row: updated, totals: totals(store.rows()), summary: summary(store.rows()), groups: buyerGroups(store.rows()) });
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use(errorHandler(log));
  return app;
}
