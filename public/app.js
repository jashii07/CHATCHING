// The page: one row per buyer in an AG Grid table (6 buyers per page), and a drawer to fix a buyer's
// items, quantities and dates. Every change goes to the server (PUT /api/orders/:id), which recalculates
// the price, totals and unclear flag; the page never does money maths.
// "Read orders" sends the pasted chats to POST /api/parse and shows the rows it replies with.
// Layout and colours follow the UI spec (PLAN.md Section 12).
// Icons: Lucide (pinned in index.html). Static icons are <i data-lucide="..."> tags; the rest are built in code.

// The AG Grid features later steps rely on (all Community, none Enterprise).
const NEEDED_MODULES = {
  CsvExportModule: "CSV export",
  HighlightChangesModule: "cell flashing",
  QuickFilterModule: "quick filter",
  PaginationModule: "pagination",
};
const BUYERS_PER_PAGE = 6;

const phone = window.matchMedia("(max-width: 640px)");
const LOCKED_WORDS = "Invoice sent: items are locked so the invoice and the table always match.";
const NO_ANSWER_WORDS = "PayPal didn't answer, so this buyer's invoice may already exist. Click Send invoices to check, or start a New batch.";
const laptop = window.matchMedia("(min-width: 1024px)");

const $ = (id) => document.getElementById(id);

// Filled in from /api/state: the currency and menu come from data/menu.json, never from the code.
let currency = null;
let menuItems = [];
let grid = null;
let totals = { orders: 0, total: "0.00" };
let summary = null;
let source = null; // the chats the rows came from: { text, chatDate, messages }
let batch = null; // this table's batch id: the server having another one means the table is no longer this one
let rowsById = new Map(); // the order rows (one per item), as the server last confirmed them
let groups = []; // buyer groups from the server: { buyer, rowIds, items, total, cancelled }
let openGroupId = null; // the buyer shown in the drawer (its first row id)
let kitchen = { days: [], text: "" }; // the kitchen list from the server (src/kitchen.js)
let texts = new Map(); // buyer (lowercase) -> { message, reminder, question }: ready-to-send texts from the server (src/messages.js)
let kitchenOpen = false; // the drawer shows the kitchen list instead of a buyer
let pairOpen = false; // the drawer shows the "Open on my phone" QR instead
let onlyNeedsCheck = false; // the Needs check card filters the table to buyers that need a check
let chatDate = null; // for the CSV file name
let returnFocus = null;
let paypalReady = false; // both PayPal keys are set on the server
let sending = false; // invoices are being sent: the Send buttons wait
let sendProgress = null; // while sending: { done, total }, counted from real replies only
let sendErrors = new Map(); // buyer (lowercase) -> why their invoice failed in the last send
let checking = false; // a status check is on its way to the server
let recording = false; // a cash / bank payment is being recorded
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let pollTimer = null;
let pollUntil = 0;
const POLL_MS = 20_000; // PLAN.md Section 3: every 20 s while the page is open
const POLL_FOR_MS = 30 * 60_000; // then stop, so a forgotten tab doesn't ask PayPal all day
const TABLE_CLEARED = "Your table was cleared: the free server forgets tables when it sleeps. Click Load demo, then Read orders.";

// "54.00" -> "RM 54.00" (MYR) or "$54.00" (USD). Same Intl options as formatMoney in src/money.js.
function formatMoney(amount) {
  if (amount == null || !currency) return amount ?? "";
  return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(Number(amount));
}

// "2026-10-31" -> "Sat 31 Oct". UTC, so the seller's time zone can't shift the day.
function formatDate(iso, withWeekday = true) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { ...(withWeekday && { weekday: "short" }), day: "numeric", month: "short", timeZone: "UTC" });
}

// Today in the seller's own time zone (toISOString() would give the UTC date).
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function showError(message, box = "error") {
  $(box).textContent = `Error: ${message}`;
  $(box).hidden = false;
}

function hideError(box = "error") {
  $(box).hidden = true;
}

// "cake-slice" or "CakeSlice" -> a Lucide icon as an <svg>, or nothing if it doesn't exist or the
// icon library didn't load (the words always show anyway).
function icon(name) {
  const pascal = String(name ?? "").replace(/(^|-)([a-z])/g, (m, dash, ch) => ch.toUpperCase());
  const node = window.lucide?.icons?.[pascal];
  if (!node) return document.createTextNode("");
  const svg = window.lucide.createElement(node);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("lucide");
  return svg;
}

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ordersText = (n) => `${plural(n, "order")} ready`;
const menuItem = (id) => menuItems.find((item) => item.id === id) ?? null;
// "Classic brownies (box of 6)" -> "Classic brownies": short enough for a chip.
const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");

// "Kak Ros" -> "KR", "Lina" -> "L". Only letters and digits, so emoji in a name can't break it.
function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

// ---- One table row per buyer, built from the server's groups (no money maths: totals come from the server) ----

function buyerRows() {
  return groups.map((group) => {
    const rows = group.rowIds.map((id) => rowsById.get(id)).filter(Boolean);
    const active = rows.filter((row) => row.orderStatus === "active");
    const unclear = active.filter((row) => row.unclear);
    const payerLink = active.find((row) => row.payerLink)?.payerLink ?? null;
    return {
      sendError: sendErrors.get(String(group.buyer).trim().toLowerCase()) ?? "", // shown as amber "Error:"
      key: String(group.buyer).trim().toLowerCase(),
      texts: texts.get(String(group.buyer).trim().toLowerCase()) ?? {}, // what the Copy buttons copy
      payerLink, // set once the buyer's invoice is sent
      collected: active.length > 0 && active.every((row) => row.collected === true), // our own mark (Step 10c), never PayPal's
      // Clear, not cancelled, and no sent invoice yet (a draft whose send failed is sent again).
      toSend: !group.cancelled && group.total != null && !active.some((row) => row.invoiceId && row.invoiceStatus !== "Draft"),
      id: group.rowIds[0],
      buyer: group.buyer,
      rows,
      cancelled: group.cancelled,
      items: group.items,
      total: group.total,
      unclear: unclear.length > 0,
      reason: [...new Set(unclear.map((row) => row.reason))].join(" "),
      dates: [...new Set(active.map((row) => row.deliveryDate).filter(Boolean))].sort(),
      status: group.cancelled ? "Cancelled" : active[0]?.invoiceStatus ?? "Draft",
    };
  });
}

// "3 × Classic brownies (box of 6); 1 × Choc chip cookies (jar)": the items as plain text.
const itemsText = (data) => data.rows
  .map((row) => {
    const item = menuItem(row.itemId);
    const text = item ? `${row.qty ?? "?"} × ${item.name}` : "Item missing";
    return row.orderStatus === "cancelled" ? `${text} (cancelled)` : text;
  })
  .join("; ");

const buyerSub = (data) => (data.cancelled ? "Cancelled" : data.unclear ? "Needs a check" : data.payerLink ? "Invoice sent" : plural(data.items, "item"));

// After the invoice is sent: the payer link (opens PayPal's pay page) and a Copy button for the chat.
// Both are inside the row, so the row-click handler ignores clicks on links and buttons.
function payLink(data) {
  if (!data.payerLink) return null;
  const line = el("span", "pay-link");
  const link = Object.assign(el("a", "", ""), { href: data.payerLink, target: "_blank", rel: "noopener" });
  link.append(icon("external-link"), "Payer link");
  const copy = Object.assign(el("button", "ghost small copy-link", "Copy link"), { type: "button" });
  copy.dataset.link = data.payerLink;
  copy.setAttribute("aria-label", `Copy ${data.buyer}'s payer link`);
  line.append(link, copy);
  if (data.texts.message) line.append(copyTextButton(data, "message"));
  return line;
}

// Step 10: "Copy message" / "Copy reminder" / "Copy question". The words come from the server (src/messages.js):
// names, items, money and links are filled in by code, never by the AI.
const COPY_LABELS = { message: "Copy message", reminder: "Copy reminder", question: "Copy question" };
function copyTextButton(data, kind, id = "") {
  const button = Object.assign(el("button", "ghost small copy-text", COPY_LABELS[kind]), { type: "button" });
  if (id) button.id = id;
  button.dataset.buyer = data.key;
  button.dataset.kind = kind;
  button.setAttribute("aria-label", `${COPY_LABELS[kind]} for ${data.buyer || "this buyer"}`);
  return button;
}

// The question for an unclear buyer, under the "Check:" words.
function questionLine(data) {
  if (data.cancelled || !data.texts.question) return null;
  const line = el("span", "pay-link");
  line.append(copyTextButton(data, "question"));
  return line;
}
const datesText = (data) => (data.dates.length ? data.dates.map((d) => formatDate(d)).join(", ") : "—");
const checkText = (data) => (data.unclear && !data.cancelled ? `Check: ${data.reason}` : "");

function avatar(name, extra = "") {
  return el("span", `avatar ${extra}`.trim(), initials(name));
}

// "3 × Classic brownies" with the item's food icon (from menu.json); "Item missing" when the AI couldn't tell.
function itemChip(row) {
  const item = menuItem(row.itemId);
  const chip = el("span", `chip${row.orderStatus === "cancelled" ? " is-cancelled" : ""}`);
  chip.append(icon(item?.icon ?? "utensils-crossed"), item ? `${row.qty ?? "?"} × ${shortName(item.name)}` : "Item missing");
  return chip;
}

function chips(data) {
  const list = el("span", "chips");
  list.append(...data.rows.map(itemChip));
  return list;
}

// One icon per status, so the tag reads at a glance (the words carry the meaning, not the icon).
const STATUS_ICONS = {
  Draft: "pencil-line", Sent: "send", "Part paid": "hourglass", Paid: "circle-check",
  "Paid (cash/bank)": "banknote", "Cancelled/Refunded": "circle-x", Cancelled: "circle-x", Collected: "package-check",
};

function statusTag(label) {
  const tag = el("span", `badge badge-${String(label).toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`);
  tag.append(icon(STATUS_ICONS[label] ?? "circle"), label);
  return tag;
}

// PayPal's status, plus our own Collected badge once the order was picked up (Step 10c).
function statusTags(data) {
  const tags = el("span", "status-tags");
  tags.append(statusTag(data.status));
  if (data.collected) tags.append(statusTag("Collected"));
  return tags;
}

// ---- Cell renderers (laptop + iPad) ----

function buyerCell(p) {
  if (p.node.rowPinned) return el("span", "pinned-label", "Total");
  const cell = el("span", "buyer");
  const text = el("span", "");
  // The narrower table has no Date column (no room), so the date sits under the name, as on the phone cards.
  const sub = layout === "ipad" && !p.data.cancelled ? `${buyerSub(p.data)}, ${datesText(p.data)}` : buyerSub(p.data);
  text.append(el("span", "buyer-name", p.data.buyer || "No name"), el("span", "buyer-sub", sub));
  cell.append(avatar(p.data.buyer), text);
  return cell;
}

function itemsCell(p) {
  if (p.node.rowPinned) return el("span", "pinned-label", p.value);
  const cell = el("span", "items-cell");
  cell.append(chips(p.data));
  const words = checkText(p.data);
  if (words) cell.append(el("span", "check-text", words));
  const ask = questionLine(p.data);
  if (ask) cell.append(ask);
  if (p.data.sendError) cell.append(el("span", "check-text", `Error: ${p.data.sendError}`));
  const link = payLink(p.data);
  if (link) cell.append(link);
  return cell;
}

// The blue chevron says "this row opens": blue = clickable.
function openCell(p) {
  if (p.node.rowPinned) return "";
  const cue = el("span", "open-cue");
  cue.append(icon("chevron-right"));
  return cue;
}

// ---- Phone: each buyer is one stacked card (a single column) ----

function cardCell(p) {
  // Cards on a wider screen (a narrow table) keep the pinned totals row; phones use the sticky bar instead.
  if (p.node.rowPinned) {
    const line = el("span", "card-top");
    line.append(el("span", "pinned-label", `Total: ${ordersText(p.data.orders)}`), el("span", "card-total money", formatMoney(p.data.total)));
    return line;
  }
  const data = p.data;
  const card = el("span", "card-row");
  const top = el("span", "card-top");
  const who = el("span", "buyer");
  const text = el("span", "");
  text.append(el("span", "buyer-name", data.buyer || "No name"), el("span", "buyer-sub", `${buyerSub(data)}, ${datesText(data)}`));
  who.append(avatar(data.buyer), text);
  const right = el("span", "card-right");
  right.append(el("span", "card-total money", data.total == null ? "—" : formatMoney(data.total)), statusTags(data));
  top.append(who, right);
  card.append(top, chips(data));
  const words = checkText(data);
  if (words) card.append(el("span", "check-text", words));
  const ask = questionLine(data);
  if (ask) card.append(ask);
  if (data.sendError) card.append(el("span", "check-text", `Error: ${data.sendError}`));
  const link = payLink(data);
  if (link) card.append(link);
  return card;
}

// Every column always exists, so the search box and the CSV export work the same on every screen:
// card layouts show only the card column, the others hide it. Minimum widths add up to LAPTOP_MIN (with
// the Date column) and IPAD_MIN (without), so a chosen set always fits the table: nothing is cut off.
function columns(size) {
  const isPhone = size === "phone" || size === "cards";
  const wide = size === "laptop";
  return [
    {
      colId: "card", headerName: "Buyers", flex: 1, autoHeight: true, wrapText: true, hide: !isPhone,
      cellClass: "card-cell", cellRenderer: cardCell,
      valueGetter: (p) => (p.node.rowPinned ? `${ordersText(p.data.orders)} ${p.data.total}` : `${p.data.buyer} ${itemsText(p.data)}`), // what the search box looks at
    },
    { colId: "buyer", field: "buyer", headerName: "Buyer", minWidth: wide ? 200 : 170, flex: 1, wrapText: true, autoHeight: true, hide: isPhone, cellRenderer: buyerCell },
    {
      colId: "items", headerName: "Items", minWidth: wide ? 220 : 200, flex: 2.4, autoHeight: true, wrapText: true, hide: isPhone, cellRenderer: itemsCell,
      // The totals row carries its own numbers, so AG Grid sees them change and redraws the cell.
      valueGetter: (p) => (p.node.rowPinned ? ordersText(p.data.orders) : itemsText(p.data)),
    },
    {
      colId: "date", headerName: "Date", minWidth: 130, flex: 0.8, wrapText: true, hide: !wide,
      valueGetter: (p) => (p.node.rowPinned ? "" : datesText(p.data)),
    },
    {
      colId: "total", headerName: "Total", type: "rightAligned", minWidth: 140, flex: 0.8, hide: isPhone,
      cellClass: ["money", "ag-right-aligned-cell"],
      valueGetter: (p) => (p.data.total == null ? "—" : formatMoney(p.data.total)),
    },
    {
      colId: "status", headerName: "Status", minWidth: wide ? 156 : 128, flex: 0.9, hide: isPhone,
      valueGetter: (p) => (p.node.rowPinned ? "" : p.data.collected ? `${p.data.status}, collected` : p.data.status),
      cellRenderer: (p) => (p.node.rowPinned ? "" : statusTags(p.data)),
    },
    { colId: "open", headerName: "", width: wide ? 64 : 48, minWidth: wide ? 64 : 48, maxWidth: wide ? 64 : 48, hide: isPhone, cellClass: "open-cell", cellRenderer: openCell },
  ];
}

// Quartz theme in the spec's colours. Names checked against the AG Grid 36.2.0 file itself.
function makeTheme(isPhone) {
  return agGrid.themeQuartz.withParams({
    backgroundColor: "#FFFFFF",
    foregroundColor: "#1D1D1F",
    textColor: "#1D1D1F",
    accentColor: "#3A5BC7",
    borderColor: "#EFEBE5",
    headerBackgroundColor: "#FFFFFF",
    headerTextColor: "#6E6E73",
    headerFontWeight: 500,
    headerFontSize: 14,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    fontSize: 16,
    rowHoverColor: "#FAF8F5", // light warm tint, not blue: blue means clickable
    selectedRowBackgroundColor: "#F5F1EB",
    pinnedRowBackgroundColor: "#FAF8F5",
    valueChangeValueHighlightBackgroundColor: "#DCF2E3", // the Paid flash: green = money arrived
    rowHeight: 92, // generous: a buyer row breathes
    headerHeight: isPhone ? 0 : 52, // phone cards need no header
    wrapperBorder: false,
    wrapperBorderRadius: 16,
    rowBorder: true, // a hairline between buyers
    columnBorder: false,
    headerColumnBorder: false,
    headerColumnResizeHandleColor: "transparent",
    cellHorizontalPaddingScale: isPhone ? 0.5 : 1.1,
  });
}

let themes = null;
// Which columns fit is decided by the TABLE's own width, not the screen's: with the chat box open on a laptop
// the table is much narrower (814 px at 1280). Phones always get cards; a table narrower than IPAD_MIN gets
// the cards too, so no column is ever pushed out of sight.
const LAPTOP_MIN = 200 + 220 + 130 + 140 + 156 + 64; // 910: buyer, items, date, total, status, arrow
const IPAD_MIN = 170 + 200 + 140 + 128 + 48; // 686: no Date column; tag icons hidden (styles.css)
let layout = null; // "phone", "cards", "ipad" or "laptop"
function chooseLayout() {
  if (phone.matches) return "phone";
  const width = $("grid").clientWidth;
  return width >= LAPTOP_MIN ? "laptop" : width >= IPAD_MIN ? "ipad" : "cards";
}
const cardLayout = () => layout === "phone" || layout === "cards";

// The pinned totals row (laptop + iPad) and the sticky bar (phone) both show the server's totals.
function showTotals() {
  if (!grid) return;
  grid.setGridOption("pinnedBottomRowData", phone.matches ? [] : [{ id: "totals", orders: totals.orders, total: totals.total }]);
  $("phone-sum").replaceChildren(el("span", "", `Total: ${ordersText(totals.orders)}`), el("span", "money", formatMoney(totals.total)));
}

// The Send invoices buttons (above the table; in the sticky bar on phones): "Send 7 invoices", or
// waiting while sending, or nothing to send. Missing PayPal keys: an amber note next to them instead.
function showSendButtons() {
  const rows = buyerRows();
  const count = rows.filter((row) => row.toSend).length;
  // Every clear order already has an invoice: say so, instead of a grey button with no reason.
  const allSent = count === 0 && rows.some((row) => row.payerLink);
  const label = sending
    ? (sendProgress ? `Sending ${Math.min(sendProgress.done + 1, sendProgress.total)} of ${sendProgress.total}...` : "Sending...")
    : count ? `Send ${plural(count, "invoice")}` : allSent ? "All invoices sent" : "Send invoices";
  for (const button of document.querySelectorAll("[data-send-invoices]")) {
    button.disabled = sending || !paypalReady || count === 0;
    button.toggleAttribute("aria-busy", sending);
    button.replaceChildren(icon(allSent && !sending ? "circle-check" : "send"), label);
  }
  $("send-warning").hidden = paypalReady || count === 0;
  // Once invoices exist, reading again is refused: New batch is the way on.
  const invoiced = [...rowsById.values()].some((row) => row.invoiceId);
  const newBatchNeeded = invoiced || [...rowsById.values()].some((row) => row.sendUnknown); // reading is refused then too
  for (const button of document.querySelectorAll("[data-new-batch]")) button.hidden = !newBatchNeeded;
  $("refresh-status").hidden = !paypalReady || !invoiced;
  // A sent invoice is what a pickup scan looks for. On phones the sticky bar makes room for the button.
  for (const button of document.querySelectorAll("[data-pickup-scan]")) button.hidden = !invoiced;
  document.body.classList.toggle("can-scan", invoiced);
}

// Our own page arrows drive AG Grid's pagination. One row = one buyer, so a buyer is never split.
function showPager() {
  if (!grid) return;
  const pages = grid.paginationGetTotalPages();
  const page = grid.paginationGetCurrentPage();
  $("pager").hidden = pages <= 1;
  $("page-text").textContent = `Page ${page + 1} of ${pages}`;
  $("page-prev").disabled = page === 0;
  $("page-next").disabled = page >= pages - 1;
}

// The four summary cards. Figures come from the server; Expected is the hero.
// The cards turn amber when an order needs checking and green when money has arrived.
function showSummary() {
  if (!summary) return;
  const set = (id, figure, caption, state) => {
    const card = $(id);
    const el = card.querySelector("[data-figure]");
    el.textContent = figure;
    el.style.setProperty("--figure-chars", figure.length); // longer figures shrink to fit the card (styles.css)
    card.querySelector("[data-caption]").textContent = caption;
    card.classList.remove("is-check", "is-paid");
    if (state) card.classList.add(state);
  };
  set("stat-expected", formatMoney(summary.expected), summary.ready ? `From ${plural(summary.ready, "order")} ready to invoice` : "No orders ready yet");
  set("stat-orders", String(summary.orders), summary.orders ? "One per buyer" : "Paste chats to start");
  set("stat-paid", formatMoney(summary.paid), summary.paidOrders ? `From ${plural(summary.paidOrders, "order")}` : "Nothing paid yet", summary.paidOrders ? "is-paid" : "");
  set("stat-check", String(summary.needsCheck), summary.needsCheck ? `${plural(summary.needsCheck, "order")} to fix` : "All clear", summary.needsCheck ? "is-check" : "");
  // Nothing left to check: the filter switches itself off, so the table never sits empty.
  if (!summary.needsCheck && onlyNeedsCheck) setNeedsCheckFilter(false);
  const card = $("stat-check");
  card.disabled = !summary.needsCheck;
  card.setAttribute("aria-pressed", String(onlyNeedsCheck));
  card.classList.toggle("is-active", onlyNeedsCheck);
  $("check-cue").replaceChildren(...(summary.needsCheck ? [onlyNeedsCheck ? "Show all buyers" : "Show only these", icon("chevron-right")] : []));
}

// The Needs check card filters the table to the buyers that need a check (AG Grid's external filter).
function setNeedsCheckFilter(on) {
  onlyNeedsCheck = on;
  grid?.onFilterChanged();
  const shown = buyerRows().filter((row) => row.unclear && !row.cancelled).length;
  $("filter-note").hidden = !on;
  $("filter-note-text").textContent = `Showing ${plural(shown, "buyer")} that ${shown === 1 ? "needs" : "need"} a check.`;
  showSummary();
  showPager();
}

// Export CSV: every buyer (whatever the search or filter shows), one row each, opens in Excel.
// The total is a plain number ("70.00") so Excel can add it up. AG Grid builds the CSV text; we add a
// byte-order mark so Excel reads it as UTF-8 (otherwise "×" and accented names come out garbled).
function exportCsv() {
  if (!grid) return;
  const csv = grid.getDataAsCsv({
    columnKeys: ["buyer", "items", "date", "total", "status"],
    exportedRows: "all",
    skipPinnedBottom: true,
    processHeaderCallback: (p) => (p.column.getColId() === "total" ? `Total (${currency})` : p.column.getColDef().headerName),
    processCellCallback: (p) => {
      const id = p.column.getColId();
      if (id === "total") return p.node.data.total ?? "";
      if (id === "date") return p.node.data.dates.join(", ");
      return p.value ?? "";
    },
  });
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" })),
    download: `chatching-orders-${chatDate ?? todayLocal()}.csv`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Setup details for the developer and judges, in the quiet footer (not in the seller's way).
// Rows read without AI say so here too, for that batch (Step 10).
let setup = null; // the setup facts from /api/state
function showSetup() {
  if (!setup) return;
  const state = setup;
  const items = [
    `Menu: ${state.menu.items.length} items in ${currency}`,
    `AI mode: ${source?.reader === "fallback" ? "read without AI" : state.aiMode}`,
    `PayPal keys: ${state.paypalConfigured ? "set" : "missing"}`,
    `Gemini key: ${state.geminiConfigured ? "set" : "missing"}`,
  ];
  $("setup").replaceChildren(...items.map((text) => el("li", "", text)));
}

// No rows yet -> 1 Paste; rows but no invoices -> 2 Review; any invoice sent -> 3 Get paid.
function showStep(rows) {
  const step = !rows.length ? 1 : rows.some((row) => row.invoiceId) ? 3 : 2;
  for (const li of document.querySelectorAll(".steps li")) {
    const current = Number(li.dataset.step) === step;
    li.classList.toggle("current", current);
    if (current) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
}

// Folded: the chat box becomes a slim "15 messages read  Edit" bar and the table gets the full width.
function foldChats(folded) {
  $("chat-bar").hidden = !folded;
  $("chats").hidden = folded;
  $("layout").classList.toggle("is-folded", folded);
  $("chat-hide").hidden = !source;
  if (!folded) $("chats").open = true;
}

function showSource() {
  if (!source) return;
  $("chat").value = source.text;
  $("chat-date").value = source.chatDate;
  $("chat-bar-text").replaceChildren(`${plural(source.messages, "message")} read`, el("span", "bar-date", ` from ${formatDate(source.chatDate, false)}`));
}

// The table got wider or narrower (screen, chat box opened or folded): switch theme and columns.
function fitToWidth() {
  if (!grid) return;
  layout = chooseLayout();
  $("grid").dataset.layout = layout;
  const defs = columns(layout);
  grid.updateGridOptions({ theme: cardLayout() ? themes.phone : themes.wide, columnDefs: defs });
  // A column that comes back (Date) would otherwise be put at the end: keep the order of the definitions.
  grid.applyColumnState({ state: defs.map((def) => ({ colId: def.colId, hide: def.hide })), applyOrder: true });
  showTotals();
}

// onlyId: redraw just that buyer's row (while sending invoices, so the other rows don't flicker).
function refreshTable(onlyId = null) {
  if (!grid) return;
  grid.setGridOption("rowData", buyerRows());
  const node = onlyId && grid.getRowNode(onlyId);
  grid.redrawRows(node ? { rowNodes: [node] } : undefined); // chips, check words and heights follow the new data
  showTotals();
  showPager();
  showSendButtons();
}

// ---- The drawer: fix one buyer's items, quantities and dates ----

function field(label, control) {
  const wrap = el("label", "field");
  wrap.append(el("span", "field-label", label), control);
  return wrap;
}

function editCard(row, askSendAnyway = false) {
  const cancelled = row.orderStatus === "cancelled";
  const invoiced = Boolean(row.invoiceId || row.sendUnknown); // the invoice must keep matching what PayPal has
  const card = el("section", `edit-card${row.unclear && !cancelled ? " is-unclear" : ""}${cancelled ? " is-cancelled" : ""}`);
  const item = menuItem(row.itemId);
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  name.append(el("span", "icon-circle small"), item ? item.name : "Item missing");
  name.firstChild.append(icon(item?.icon ?? "utensils-crossed"));
  title.append(name, el("span", "money", row.lineTotal == null ? "—" : formatMoney(row.lineTotal)));
  card.append(title);

  const select = el("select", "");
  if (!item) select.append(Object.assign(el("option", "", "Choose an item"), { value: "", disabled: true, selected: true }));
  for (const option of menuItems) {
    select.append(Object.assign(el("option", "", `${option.name}, ${formatMoney(option.price)}`), { value: option.id, selected: option.id === row.itemId }));
  }
  const qty = Object.assign(document.createElement("input"), { type: "number", min: 1, max: 99, step: 1, inputMode: "numeric", value: row.qty ?? "" });
  const date = Object.assign(document.createElement("input"), { type: "date", value: row.deliveryDate ?? "" });
  for (const [control, name2] of [[select, "itemId"], [qty, "qty"], [date, "deliveryDate"]]) {
    control.dataset.row = row.id;
    control.dataset.field = name2;
    control.id = `edit-${row.id}-${name2}`;
    control.disabled = cancelled || invoiced;
  }
  const pair = el("div", "field-pair");
  pair.append(field("Qty", qty), field("Date", date));
  card.append(field("Item", select), pair);
  if (cancelled) card.append(el("p", "hint", "This order is cancelled, so it can't be changed."));
  else if (!invoiced && row.unclear) card.append(el("p", "check-text", `Check: ${row.reason}`));
  // Step 7a: the buyer wrote a price that isn't the menu's. The seller has seen it; the invoice always
  // uses the menu price, so this only clears the check.
  if (!cancelled && !invoiced && row.priceCheck && !row.priceCheck.kept) {
    const keep = Object.assign(el("button", "ghost small keep-price", "Keep menu price"), { type: "button", id: `keep-${row.id}` });
    keep.dataset.row = row.id;
    card.append(keep);
  }
  // The buyer already has an invoice from an earlier batch today. Send anyway says this is a real second order.
  if (askSendAnyway) card.append(Object.assign(el("button", "ghost small send-anyway", "Send anyway"), { type: "button", id: "send-anyway" }));
  // Remove this line: the buyer's last item asks "Cancel this buyer's order?" first (removeItem).
  if (!cancelled && !invoiced) {
    const remove = Object.assign(el("button", "ghost small remove-item", ""), { type: "button", id: `remove-${row.id}` });
    remove.append(icon("trash"), "Remove item");
    remove.dataset.row = row.id;
    remove.setAttribute("aria-label", `Remove ${item ? item.name : "this item"}`);
    card.append(remove);
  }
  return card;
}

// "Add item": a menu item the buyer doesn't have yet + a quantity. The server sets the price from the menu.
function addCard(data) {
  const active = data.rows.filter((row) => row.orderStatus === "active");
  const choices = menuItems.filter((option) => !active.some((row) => row.itemId === option.id));
  if (data.cancelled || data.payerLink || active.some((row) => row.invoiceId || row.sendUnknown) || !choices.length) return null;
  const card = el("section", "edit-card add-card");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon("plus"));
  name.append(circle, "Add item");
  title.append(name);
  const select = Object.assign(el("select", ""), { id: "add-item-select" });
  for (const option of choices) select.append(Object.assign(el("option", "", `${option.name}, ${formatMoney(option.price)}`), { value: option.id }));
  const qty = Object.assign(document.createElement("input"), { type: "number", min: 1, max: 99, step: 1, inputMode: "numeric", value: 1, id: "add-item-qty" });
  const pair = el("div", "field-pair"); // Qty at the same half width as in the item cards above
  pair.append(field("Qty", qty));
  const button = Object.assign(el("button", "", ""), { type: "button", id: "add-item" });
  button.append(icon("plus"), "Add item");
  card.append(title, field("Item", select), pair, button);
  return card;
}

// The drawer's add / remove / cancel: the reply is the whole table (rows were added or removed). The drawer
// stays on the same buyer, whose first row id may have changed. Same updates as an edit, nothing folds.
async function changeItems(method, path, body) {
  const key = buyerRows().find((row) => row.id === openGroupId)?.key;
  try {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    const group = reply.groups.find((g) => String(g.buyer).trim().toLowerCase() === key);
    if (group) openGroupId = group.rowIds[0];
    rowsById = new Map(reply.orders.map((row) => [row.id, row]));
    totals = reply.totals;
    summary = reply.summary;
    groups = reply.groups;
    kitchen = reply.kitchen;
    texts = textMap(reply.texts);
    hideError("drawer-error");
    loadPanel(); // the buyer's messages: the first row id may be new
  } catch (err) {
    showError(`That change was not saved (${err.message}).`, "drawer-error");
    await tableStillHere();
  }
  refreshTable();
  showSummary();
  renderDrawer();
}

async function addItem() {
  const qty = Number($("add-item-qty").value);
  if (!(Number.isInteger(qty) && qty >= 1 && qty <= 99)) {
    showError(`That item was not added (Quantity must be a whole number from 1 to 99, got ${$("add-item-qty").value || "nothing"}).`, "drawer-error");
    return $("add-item-qty").focus();
  }
  await changeItems("POST", `/api/buyers/${encodeURIComponent(openGroupId)}/items`, { itemId: $("add-item-select").value, qty });
  ($("add-item-select") ?? $("drawer-close")).focus();
}

// The last item: removing it would leave an empty order, so the seller is asked to cancel the order instead.
async function removeItem(button) {
  const data = buyerRows().find((row) => row.id === openGroupId);
  if (!data) return;
  const active = data.rows.filter((row) => row.orderStatus === "active");
  if (active.length === 1) {
    if (!window.confirm(`Cancel this buyer's order? ${data.buyer || "This buyer"} has no other items. The order stays in the table as cancelled; to undo it, read the chats again.`)) return;
    await changeItems("POST", `/api/buyers/${encodeURIComponent(openGroupId)}/cancel`);
    return $("drawer-close").focus();
  }
  await changeItems("DELETE", `/api/orders/${encodeURIComponent(button.dataset.row)}`);
  ($("drawer-body").querySelector(".remove-item, #add-item-select") ?? $("drawer-close")).focus();
}

// The drawer has three parts, so a slow panel or QR code never redraws (and unfocuses) the edit fields:
// what the buyer wrote, the items to edit (+ record payment), and the invoice's QR code.
// display: contents (styles.css), so their cards still sit in the drawer's one column.
const drawerChat = el("div", "drawer-part");
const drawerItems = el("div", "drawer-part");
const drawerQr = el("div", "drawer-part");
$("drawer-body").append(drawerChat, drawerItems, drawerQr);

function renderDrawer() {
  if (pairOpen) return renderPair();
  if (kitchenOpen) return renderKitchen();
  const data = buyerRows().find((row) => row.id === openGroupId);
  if (!data) return closeDrawer();
  $("drawer-foot").textContent = "Changes save as you make them. Prices and totals come from your menu.";
  $("drawer-avatar").textContent = initials(data.buyer);
  $("drawer-title").textContent = data.buyer || "No name";
  $("drawer-sub").textContent = data.cancelled ? "Cancelled order"
    : data.total == null ? "Needs a check before it can be invoiced"
    : `${plural(data.items, "item")}, ${formatMoney(data.total)} in total${data.payerLink ? `. Invoice: ${data.status}` : ""}`;
  if (data.collected) $("drawer-sub").append(" ", statusTag("Collected"));
  // Once the invoice is sent, the items are locked: said once, above them (the server refuses changes too).
  const locked = data.rows.some((row) => row.orderStatus === "active" && row.invoiceId);
  const noAnswer = data.rows.some((row) => row.sendUnknown);
  const askOn = data.rows.find((row) => row.orderStatus === "active" && !row.invoiceId && row.earlierInvoice && !row.earlierInvoice.kept)?.id;
  drawerItems.replaceChildren(...(locked ? [el("p", "hint locked-note", LOCKED_WORDS)] : noAnswer ? [el("p", "hint locked-note", NO_ANSWER_WORDS)] : []), ...data.rows.map((row) => editCard(row, row.id === askOn)));
  const adding = addCard(data);
  if (adding) drawerItems.append(adding);
  const picked = collectedCard(data);
  if (picked) drawerItems.append(picked);
  const ready = textCard(data);
  if (ready) drawerItems.append(ready);
  const pay = payCard(data);
  if (pay) drawerItems.append(pay);
}

// Step 10: the texts for this buyer, shown in full so the seller sees exactly what they copy.
const TEXT_TITLES = { question: "Question to ask", message: "Payment message", reminder: "Reminder (still unpaid)" };
function textCard(data) {
  const kinds = ["question", "message", "reminder"].filter((kind) => !data.cancelled && data.texts[kind]);
  if (!kinds.length) return null;
  const card = el("section", "edit-card text-card");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon("message-square-text"));
  name.append(circle, `Ready to send to ${data.buyer || "this buyer"}`);
  title.append(name);
  card.append(title);
  for (const kind of kinds) {
    const block = el("div", "text-block");
    block.append(el("span", "field-label", TEXT_TITLES[kind]), Object.assign(el("p", "message-text", data.texts[kind]), { id: `text-${kind}` }), copyTextButton(data, kind, `copy-${kind}`));
    card.append(block);
  }
  card.append(el("p", "hint", "Written by the app from your menu and PayPal, not by the AI. Paste it into the chat."));
  return card;
}

// ---- The buyer panel (Step 7, "Show your work"): the AI's note + what the buyer wrote ----

let panel = null; // { id, data } for the open drawer, from GET /api/buyers/:id/panel
const qrCodes = new Map(); // invoice id -> { png } or { notice } (a QR code never changes)

const MARK_NAMES = { item: "menu item", qty: "quantity", day: "day", fulfilment: "pickup or delivery", change: "change", price: "price", "price-check": "price to check" };

// The buyer's messages as text segments (never HTML): the marked parts sit in <mark> elements.
function chatCard(data) {
  const card = el("section", "edit-card chat-card");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon("message-circle"));
  name.append(circle, `What ${data.buyer} wrote`);
  title.append(name);
  card.append(title);
  if (data.note) {
    const note = el("p", "ai-note");
    note.append(el("span", "ai-note-label", "AI note: "), data.note);
    card.append(note);
  }
  if (!data.messages.length) card.append(el("p", "hint", "The chats for this order were not saved."));
  const list = el("ol", "chat-list");
  for (const msg of data.messages) {
    const item = el("li", `chat-msg${msg.used ? "" : " is-unused"}`);
    item.append(el("span", "chat-when", `Message ${msg.n}, ${msg.when}${msg.used ? "" : " (not used for this order)"}`));
    const text = el("p", "chat-text");
    for (const part of msg.parts) {
      if (!part.mark) text.append(part.text);
      else text.append(Object.assign(el("mark", `hl hl-${part.mark}`, part.text), { title: MARK_NAMES[part.mark] ?? "" }));
    }
    item.append(text);
    list.append(item);
  }
  if (data.messages.length) card.append(list);
  return card;
}

// The invoice's QR code from PayPal (#3b): it opens the invoice for paying.
function qrCard(invoiceId) {
  const card = el("section", "edit-card qr-card");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon("qr-code"));
  name.append(circle, "QR code for this invoice");
  title.append(name);
  card.append(title);
  const qr = qrCodes.get(invoiceId);
  if (!qr) card.append(el("p", "hint", "Loading the QR code from PayPal..."));
  else if (qr.notice) card.append(el("p", "hint", qr.notice));
  else {
    card.append(Object.assign(document.createElement("img"), {
      className: "qr-image", id: "qr-image", src: `data:image/png;base64,${qr.png}`, width: 180, height: 180,
      alt: "QR code that opens this PayPal invoice",
    }));
    const save = Object.assign(el("button", "ghost"), { type: "button", id: "save-qr" });
    save.dataset.invoice = invoiceId;
    save.append(icon("download"), "Save QR");
    card.append(save, el("p", "hint", "Send it with the payment message, so the buyer can show it at pickup. Scanning it also opens this PayPal invoice to pay."));
  }
  // The number for Pickup scan's typing box, for when there is no camera.
  const number = [...rowsById.values()].find((row) => row.invoiceId === invoiceId)?.invoiceNumber;
  if (number) card.append(el("p", "hint invoice-number", `Invoice number: ${number}`));
  return card;
}

// Saves PayPal's QR picture as a file, e.g. pickup-Lina.png, for the seller to send in the chat.
function saveQr(button) {
  const { png, fileName } = qrCodes.get(button.dataset.invoice);
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
    download: fileName,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderPanel() {
  const data = panel?.id === openGroupId ? panel.data : null;
  drawerChat.replaceChildren(...(data ? [chatCard(data)] : []));
  drawerQr.replaceChildren(...(data?.qrInvoiceId ? [qrCard(data.qrInvoiceId)] : []));
}

async function loadPanel(id = openGroupId) {
  try {
    const res = await fetch(`/api/buyers/${encodeURIComponent(id)}/panel`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.notice) { // the server no longer has this row: usually the whole table was cleared
      if ((await tableStillHere()) && id === openGroupId) drawerChat.replaceChildren(el("p", "hint", data.notice));
      return;
    }
    if (id !== openGroupId) return; // the seller opened someone else meanwhile
    panel = { id, data };
    renderPanel();
    const invoiceId = data.qrInvoiceId;
    if (invoiceId && !qrCodes.get(invoiceId)?.png) {
      const qrRes = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/qr`);
      const qr = await qrRes.json();
      qrCodes.set(invoiceId, qrRes.ok ? qr : { notice: qr.error ?? `The QR code could not be loaded (HTTP ${qrRes.status}).` });
      if (id === openGroupId) renderPanel();
    }
  } catch (err) {
    if (id === openGroupId) drawerChat.replaceChildren(el("p", "hint", `The messages could not be loaded (${err.message}).`));
    tableStillHere();
  }
}

function openDrawer(id) {
  openGroupId = id;
  kitchenOpen = false;
  returnFocus = document.activeElement;
  hideError("drawer-error");
  renderDrawer();
  renderPanel();
  loadPanel(id);
  showDrawer();
  ($("drawer-body").querySelector("select:not(:disabled), input:not(:disabled)") ?? $("drawer-close")).focus();
}

function showDrawer() {
  $("scrim").hidden = false;
  $("drawer").hidden = false;
  document.body.classList.add("drawer-open");
  requestAnimationFrame(() => $("drawer").classList.add("is-open"));
}

// ---- The kitchen list (Step 10b): per date, how many of each item to make. The server counts. ----

function kitchenDay(day) {
  const card = el("section", "edit-card kitchen-day");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon(day.date ? "calendar" : "calendar-x"));
  name.append(circle, day.label);
  title.append(name);
  card.append(title);
  if (day.items.length) {
    const list = el("ul", "kitchen-items");
    for (const item of day.items) {
      const line = el("li", "");
      line.append(el("span", "kitchen-qty", `${item.qty} ×`), el("span", "", item.name));
      list.append(line);
    }
    card.append(list);
  }
  if (day.toCheck) {
    const check = el("p", "kitchen-check");
    check.append(icon("triangle-alert"), `+${plural(day.toCheck, "order")} still to check`);
    card.append(check);
  }
  return card;
}

function renderKitchen() {
  $("drawer-avatar").replaceChildren(icon("chef-hat"));
  $("drawer-title").textContent = "Kitchen list";
  $("drawer-sub").textContent = "What to make, per day";
  $("drawer-foot").textContent = "Counts clear orders only, paid or not. Cancelled orders are left out.";
  drawerChat.replaceChildren();
  drawerQr.replaceChildren();
  const copy = Object.assign(el("button", "copy-kitchen", ""), { type: "button", id: "copy-kitchen", disabled: !kitchen.days.length });
  copy.append(icon("copy"), "Copy");
  copy.setAttribute("aria-label", "Copy the kitchen list as text");
  const days = kitchen.days.length ? kitchen.days.map(kitchenDay) : [el("p", "hint", "Nothing to make yet. Read some orders first.")];
  drawerItems.replaceChildren(copy, ...days);
}

function openKitchen() {
  openGroupId = null;
  kitchenOpen = true;
  returnFocus = document.activeElement;
  hideError("drawer-error");
  renderDrawer();
  showDrawer();
  ($("copy-kitchen").disabled ? $("drawer-close") : $("copy-kitchen")).focus();
}

// ---- Open on my phone: a one-time QR, so a phone opens this same table (src/pairing.js) ----

const PAIR_HELP = "Scan this with your phone to open the same orders. Works once, for 10 minutes.";
const PAIR_EXPIRED = "This link has expired. Make a new one on your laptop.";
let pairQr = null; // what the drawer shows: { qr }, { words } or null while the link is being made
let pairRun = 0; // goes up on every new link and on close, so a late answer can't change the drawer
let pairTimer = null;

function renderPair() {
  $("drawer-avatar").replaceChildren(icon("smartphone"));
  $("drawer-title").textContent = "Open on my phone";
  $("drawer-sub").textContent = "The same orders, on a second device";
  $("drawer-foot").textContent = "Anyone who scans this sees your orders, so keep it to yourself.";
  drawerChat.replaceChildren();
  drawerQr.replaceChildren();
  const card = el("section", "edit-card pair-card");
  if (!pairQr) card.append(el("p", "hint", "Making a link..."));
  else if (pairQr.words) {
    const note = Object.assign(el("p", "filter-note"), { id: "pair-note", role: "status" });
    note.append(el("span", "", pairQr.words));
    card.append(note);
  } else {
    card.append(Object.assign(document.createElement("img"), {
      className: "pair-qr", id: "pair-qr", src: pairQr.qr, alt: "QR code that opens these orders on your phone",
    }), Object.assign(el("p", "pair-help", PAIR_HELP), { id: "pair-help" }));
  }
  const again = Object.assign(el("button", "ghost"), { type: "button", id: "pair-new", disabled: !pairQr });
  again.append(icon("refresh-cw"), "Make a new link");
  card.append(again);
  drawerItems.replaceChildren(card);
}

function showPair(shown) {
  pairQr = shown;
  renderDrawer();
  $("pair-new").focus();
}

async function newPairLink() {
  const run = ++pairRun;
  clearTimeout(pairTimer);
  pairQr = null;
  renderDrawer();
  let reply;
  try {
    reply = await postJson("/api/pair/new", {});
  } catch (err) {
    reply = { notice: `The link could not be made (${err.message}).` };
  }
  if (run !== pairRun) return;
  if (reply.notice) return showPair({ words: reply.notice });
  showPair({ qr: reply.qr });
  pairTimer = setTimeout(() => showPair({ words: PAIR_EXPIRED }), reply.expiresInMs);
}

function openPairing() {
  openGroupId = null;
  kitchenOpen = false;
  pairOpen = true;
  returnFocus = document.activeElement;
  hideError("drawer-error");
  showDrawer();
  $("drawer-close").focus();
  newPairLink();
}

function closeDrawer() {
  openGroupId = null;
  kitchenOpen = false;
  pairOpen = false;
  pairRun++;
  clearTimeout(pairTimer);
  $("drawer").classList.remove("is-open");
  $("drawer").hidden = true;
  $("scrim").hidden = true;
  document.body.classList.remove("drawer-open");
  if (returnFocus?.isConnected) returnFocus.focus();
}

// One changed field -> PUT /api/orders/:id. The server's reply (price, totals, unclear flag, subtotals)
// updates the drawer, the table and the cards. A refused change is undone and the reason shown.
async function saveField(control) {
  const { row: id, field: name } = control.dataset;
  const raw = control.value;
  if (name === "itemId" && !raw) return;
  const value = name === "qty" ? (raw === "" ? null : Number(raw)) : raw || null;
  // The quantity is checked here first, so a typo never even reaches the server (the browser would
  // log every refused request as a red console error). The server still checks everything.
  if (name === "qty" && !(Number.isInteger(value) && value >= 1 && value <= 99)) {
    showError(`That change was not saved (Quantity must be a whole number from 1 to 99, got ${raw === "" ? "nothing" : raw}).`, "drawer-error");
    renderDrawer();
    $(`edit-${id}-${name}`)?.focus();
    return;
  }
  await putRow(id, { [name]: value });
  $(`edit-${id}-${name}`)?.focus();
}

// PUT one row's change; the server's reply updates the drawer, the table and the cards.
async function putRow(id, change) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    rowsById.set(id, reply.row);
    totals = reply.totals;
    summary = reply.summary;
    groups = reply.groups;
    kitchen = reply.kitchen;
    texts = textMap(reply.texts);
    hideError("drawer-error");
  } catch (err) {
    showError(`That change was not saved (${err.message}).`, "drawer-error");
    await tableStillHere();
  }
  refreshTable();
  showSummary();
  renderDrawer();
}

// "Keep menu price": clears the price check; focus moves to the item's dropdown (the button is gone).
async function keepMenuPrice(button) {
  button.disabled = true;
  await putRow(button.dataset.row, { keepMenuPrice: true });
  $(`edit-${button.dataset.row}-itemId`)?.focus();
  loadPanel(); // the buyer's price is no longer marked "to check"
}

// Keep Tab inside the open drawer (or the pickup sheet), and Escape closes it.
function drawerKeys(event, box = $("drawer"), close = closeDrawer) {
  if (event.key === "Escape") return close();
  if (event.key !== "Tab") return;
  const focusable = [...box.querySelectorAll("button, select, input")].filter((node) => !node.disabled && node.offsetParent !== null);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ---- The grid ----

function createOrdersGrid() {
  if (typeof agGrid === "undefined") {
    showError("The table library (AG Grid) could not load. Check the internet connection and reload.");
    return null;
  }
  themes = { wide: makeTheme(false), phone: makeTheme(true) };
  layout = chooseLayout();
  $("grid").dataset.layout = layout;
  const api = agGrid.createGrid($("grid"), {
    theme: cardLayout() ? themes.phone : themes.wide,
    columnDefs: columns(layout),
    animateRows: false,
    defaultColDef: { sortable: false, resizable: false, suppressMovable: true, cellDataType: false },
    domLayout: "autoHeight", // the page scrolls, not a box inside it
    ensureDomOrder: true, // a column that comes back (Date) is read in its place, not last (screen readers too)
    rowData: [],
    getRowId: (p) => p.data.id,
    pagination: true,
    paginationPageSize: BUYERS_PER_PAGE,
    paginationPageSizeSelector: false,
    suppressPaginationPanel: true, // our own arrows (#pager)
    onPaginationChanged: showPager,
    isExternalFilterPresent: () => onlyNeedsCheck,
    doesExternalFilterPass: (node) => node.data.unclear && !node.data.cancelled,
    rowClassRules: {
      "row-unclear": (p) => !p.node.rowPinned && (p.data?.unclear || p.data?.sendError) && !p.data.cancelled,
      "row-cancelled": (p) => !p.node.rowPinned && p.data?.cancelled,
    },
    // A click on the payer link or its Copy button does its own job, not open the drawer.
    onRowClicked: (p) => {
      if (!p.node.rowPinned && !p.event?.target?.closest?.("a, button")) openDrawer(p.data.id);
    },
    onCellKeyDown: (p) => {
      if (p.event.target?.closest?.("a, button")) return;
      if ((p.event.key === "Enter" || p.event.key === " ") && !p.node.rowPinned) {
        p.event.preventDefault();
        openDrawer(p.data.id);
      }
    },
    localeText: {
      noRowsToShow: "No orders yet. Paste chats and click Read orders.",
      noMatchingRows: "No buyers match. Clear the search, or show all buyers.",
    },
  });
  const missing = Object.keys(NEEDED_MODULES).filter((name) => !api.isModuleRegistered(name));
  if (missing.length) console.error(`AG Grid is missing: ${missing.map((name) => NEEDED_MODULES[name]).join(", ")}`);
  return api;
}

// The rows, totals, cards and chats, from /api/state or from a new parse (same shape).
function showOrders(state) {
  totals = state.totals;
  summary = state.summary;
  source = state.source;
  batch = state.batch;
  chatDate = state.source?.chatDate ?? null;
  groups = state.groups;
  kitchen = state.kitchen;
  texts = textMap(state.texts);
  rowsById = new Map(state.orders.map((row) => [row.id, row]));
  $("fallback-note").hidden = source?.reader !== "fallback" || !state.orders.length;
  showSetup();
  showSummary();
  showSource();
  foldChats(Boolean(source && state.orders.length));
  showStep(state.orders);
  if (grid) {
    fitToWidth();
    refreshTable();
  }
  showSendButtons();
  if (openGroupId || kitchenOpen) renderDrawer();
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!res.ok) throw new Error(state.error ?? `HTTP ${res.status}`);
    currency = state.menu.currency;
    menuItems = state.menu.items;
    paypalReady = state.paypalConfigured;
    setup = state;
    showCallsLeft(state.aiCallsLeft);
    showOrders(state);
    if (hasOpenInvoices()) startPolling();
  } catch (err) {
    showError(`Can't reach the server (${err.message}). Is npm start running?`);
  }
}

// The free server forgets every table when it sleeps or restarts, so a tab left open can show rows the server
// no longer has. Asked when the tab comes back, before sending and after a failed drawer request: another
// batch id means this table is gone, so the page shows the server's table, with plain words if it is empty.
// -> true while this is still the server's table. A failed check says true: the next request reports it.
function showServerTable(state) {
  const cleared = rowsById.size > 0 && !state.orders.length;
  closeDrawer();
  stopPolling();
  sendErrors = new Map();
  showProgress(0, 0);
  for (const id of ["send-message", "status-message"]) $(id).textContent = "";
  showOrders(state);
  $("read-message").textContent = cleared ? TABLE_CLEARED : "";
  if (cleared) $("read-message").scrollIntoView({ block: "center" }); // on a phone it sits far below the cards
  if (hasOpenInvoices()) startPolling();
}

// A second device on this table (Open on my phone) may have changed it: sent invoices, Collected, an edit.
const tableChanged = (orders) => JSON.stringify(orders) !== JSON.stringify([...rowsById.values()]);

async function tableStillHere() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!res.ok) return true;
    if (state.batch === batch) {
      if (tableChanged(state.orders)) {
        showOrders(state);
        if (hasOpenInvoices()) startPolling();
      }
      return true;
    }
    showServerTable(state);
    return false;
  } catch {
    return true;
  }
}

// ---- Who has paid: Refresh status + polling ----

// An invoice is open while it is sent but not (fully) paid.
const hasOpenInvoices = () => paypalReady && [...rowsById.values()].some((row) => row.invoiceId && ["Sent", "Part paid"].includes(row.invoiceStatus));
const clockTime = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Polling: every 20 s, only while this tab is visible and an invoice is still open, for 30 minutes
// from the last start (Send or Refresh starts it again). The server answers from a 10-second cache,
// so many open tabs can't flood PayPal.
function startPolling() {
  pollUntil = Date.now() + POLL_FOR_MS;
  pollTimer ??= setInterval(pollTick, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function pollTick() {
  if (!hasOpenInvoices()) return stopPolling();
  if (Date.now() > pollUntil) {
    stopPolling();
    $("status-message").textContent = "Auto-check paused after 30 minutes. Click Refresh status to check again.";
    return;
  }
  if (document.visibilityState === "visible") refreshStatus({ byHand: false });
}

// Ask the server for PayPal's latest status. The table only redraws when something changed.
// byHand: the Refresh button (errors show in the Error box); a poll only notes a problem quietly.
async function refreshStatus({ byHand }) {
  if (checking) return;
  checking = true;
  const button = $("refresh-status");
  if (byHand) {
    button.disabled = true;
    hideError();
    startPolling();
  }
  try {
    const res = await fetch("/api/invoices/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) return ($("status-message").textContent = reply.notice); // e.g. too many checks: friendly words, polling goes on
    if (reply.batch !== batch) return showServerTable(reply);
    if (reply.changed.length || tableChanged(reply.orders)) showOrders(reply);
    if (reply.changed.length) flashPaid(reply.changed);
    const paid = reply.changed.filter((c) => c.to.startsWith("Paid")).map((c) => c.buyer);
    $("status-message").textContent = [
      paid.length ? `Paid: ${paid.join(", ")}.` : "",
      `Checked with PayPal at ${clockTime()}.`,
      hasOpenInvoices() ? "Checking again every 20 seconds while this page is open." : "Every invoice is settled.",
    ].filter(Boolean).join(" ");
    if (reply.failed.length) {
      const words = `PayPal could not be asked about ${reply.failed.map((f) => `${f.buyer} (${f.reason})`).join("; ")}`;
      if (byHand) showError(words);
      else $("status-message").textContent += ` ${words}; trying again soon.`;
    }
    if (!hasOpenInvoices()) stopPolling();
  } catch (err) {
    if (byHand) showError(`The status could not be checked (${err.message}).`);
    else $("status-message").textContent = `Couldn't reach the server just now (${err.message}); trying again in 20 seconds.`;
  } finally {
    checking = false;
    button.disabled = false;
  }
}

// The Paid flash: when a buyer turns Paid, their status cell (the whole card on phones) flashes the
// green tint once. AG Grid's flashCells (Community). Nothing flashes when reduced motion is on.
function flashPaid(changed) {
  if (!grid || reducedMotion.matches) return;
  const paid = new Set(changed.filter((c) => c.to.startsWith("Paid")).map((c) => c.buyer.trim().toLowerCase()));
  const rowNodes = [];
  grid.forEachNode((node) => {
    if (paid.has(String(node.data?.buyer ?? "").trim().toLowerCase())) rowNodes.push(node);
  });
  if (rowNodes.length) grid.flashCells({ rowNodes, columns: [cardLayout() ? "card" : "status"], flashDuration: 1200, fadeDuration: 1000 });
}

// ---- Record a cash / bank-transfer payment (in the drawer) ----

// Shown for a sent, unpaid invoice. The seller picks HOW the buyer paid; the amount is the invoice's full
// total, shown here but never typed: the server takes it from the saved invoice at PayPal.
function payCard(data) {
  const invoiceId = data.rows.find((row) => row.invoiceId)?.invoiceId;
  if (!paypalReady || data.cancelled || !data.payerLink || data.status !== "Sent" || !invoiceId) return null;
  const card = el("section", "edit-card pay-card");
  const title = el("div", "edit-title");
  const name = el("span", "edit-name");
  const circle = el("span", "icon-circle small");
  circle.append(icon("banknote"));
  name.append(circle, "Paid by cash or bank transfer?");
  title.append(name, el("span", "money", formatMoney(data.total)));
  const method = Object.assign(el("select", ""), { id: "pay-method" });
  for (const [value, label] of [["CASH", "Cash"], ["BANK_TRANSFER", "Bank transfer"]]) method.append(Object.assign(el("option", "", label), { value }));
  const button = Object.assign(el("button", "", "Record payment"), { type: "button", id: "record-payment" });
  button.dataset.invoice = invoiceId;
  card.append(title, el("p", "hint", "Records the full invoice total in PayPal. It can't be undone here."), field("Paid by", method), button);
  return card;
}

async function recordPayment(button) {
  if (recording) return;
  const data = buyerRows().find((row) => row.id === openGroupId);
  const method = $("pay-method");
  const how = method.selectedOptions[0].textContent.toLowerCase();
  if (!data || !window.confirm(`Record ${formatMoney(data.total)} paid by ${how} for ${data.buyer}? It is saved in PayPal and can't be undone here.`)) return;
  recording = true;
  button.disabled = true;
  button.textContent = "Recording...";
  hideError("drawer-error");
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(button.dataset.invoice)}/payment`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: method.value }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) { // e.g. too many requests: nothing was sent to PayPal; friendly words, not an Error box
      renderDrawer();
      return document.querySelector("#drawer .pay-card")?.append(Object.assign(el("p", "hint", reply.notice), { role: "status" }));
    }
    if (reply.failed) throw new Error(reply.failed);
    closeDrawer(); // so the flash is seen, also on phones (full-screen drawer)
    showOrders(reply);
    flashPaid([{ buyer: data.buyer, to: "Paid (cash/bank)" }]);
    $("status-message").textContent = `Recorded: ${data.buyer} paid ${formatMoney(reply.recorded.amount)} by ${how}.`;
  } catch (err) {
    showError(`The payment was not recorded (${err.message}).`, "drawer-error");
    renderDrawer();
  } finally {
    recording = false;
  }
}

// ---- Pickup scan (Step 10c): the camera reads the QR here on the device; the server says who has paid ----

const SCAN_LOOKING = "Point the camera at the buyer's QR code.";
const SCAN_EVERY_MS = 200; // about 5 tries a second: quick enough for a hand, kind to a phone's battery
const SCAN_MAX_SIDE = 800; // a QR held up to the camera needs no more pixels than this
const SCAN_SKIP_MS = 3000; // time to move the last buyer's QR out of view
const OTHER_BROWSER = "It may be in orders on another device. On that device, click Open on my phone, then scan that QR here.";
let scanner = null; // public/invoice-qr.js, loaded on the first open
let scanOpen = false;
let scanStream = null; // the camera, while the sheet is open
let scanRun = 0; // goes up on every start and close, so a late permission answer can't start a closed camera
let scanTimer = null;
let scanChecking = false; // an answer is on its way from the server
let scanCameraProblem = ""; // why there is no camera: the words shown above the typing box
let scanShown = null; // the invoice the sheet shows
let scanSkip = { id: null, until: 0 }; // just done with: the same QR is often still in view when Scan next is tapped
let scanReturnFocus = null;
const scanCanvas = document.createElement("canvas");

async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const reply = await res.json();
  if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
  return reply;
}

function scanSay(words) {
  $("scan-hint").textContent = words;
  $("scan-hint").hidden = !words;
}

// jsQR comes from our own server, and only when a scan is wanted: it is 250 KB most visitors never need.
async function loadScanner() {
  const decoder = await import("./invoice-qr.js");
  if (!window.jsQR) {
    await new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement("script"), { src: "vendor/jsQR.js", onload: resolve, onerror: reject });
      document.head.append(script);
    });
  }
  return decoder;
}

function cameraWords(err) {
  if (["NotAllowedError", "SecurityError"].includes(err?.name)) return "Camera permission was refused. Type the invoice number or paste the link below.";
  if (["NotReadableError", "AbortError"].includes(err?.name)) return "The camera is busy in another app. Type the invoice number or paste the link below.";
  return "No camera found. Type the invoice number or paste the link below.";
}

function stopReading() {
  clearTimeout(scanTimer);
  scanTimer = null;
}

function stopCamera() {
  stopReading();
  scanStream?.getTracks().forEach((track) => track.stop());
  scanStream = null;
  $("scan-video").srcObject = null;
}

// One try: the current frame goes onto a canvas nobody sees, and jsQR looks for a QR in its pixels.
function readFrame() {
  const video = $("scan-video");
  if (video.videoWidth) {
    const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (scanCanvas.width !== width || scanCanvas.height !== height) Object.assign(scanCanvas, { width, height });
    const ctx = scanCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    const code = window.jsQR(ctx.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "dontInvert" });
    if (code?.data) return onScanned(code.data);
  }
  scanTimer = setTimeout(readFrame, SCAN_EVERY_MS);
}

// Our own "Open on my phone" QR, read by Pickup scan: open it, exactly as the phone's camera app would.
function openPairLink(text) {
  const link = scanner.pairLinkFrom(text, location.origin);
  if (!link) return false;
  closeScan();
  location.assign(link);
  return true;
}

function onScanned(text) {
  if (openPairLink(text)) return;
  const invoiceId = scanner.invoiceIdFromQr(text);
  const justDone = invoiceId === scanSkip.id && Date.now() < scanSkip.until;
  if (invoiceId && !justDone) return checkPickup(invoiceId);
  if (!invoiceId) scanSay(scanner.NOT_OUR_QR); // a stranger's QR never leaves the phone; keep looking
  scanTimer = setTimeout(readFrame, SCAN_EVERY_MS);
}

async function startCamera() {
  const run = ++scanRun;
  scanCameraProblem = "";
  $("scan-camera").hidden = false;
  scanSay("Starting the camera...");
  try {
    scanner ??= await loadScanner();
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("No camera", "NotFoundError");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    if (run !== scanRun) return stream.getTracks().forEach((track) => track.stop()); // closed while the seller was asked
    scanStream = stream;
    $("scan-video").srcObject = stream;
    await $("scan-video").play();
    if (run !== scanRun) return;
    scanSay(SCAN_LOOKING);
    readFrame();
  } catch (err) {
    if (run !== scanRun) return;
    stopCamera();
    scanCameraProblem = scanner ? cameraWords(err) : "The scanner could not load. Check the connection, then close this and try again.";
    $("scan-camera").hidden = true;
    scanSay(scanCameraProblem);
    $("scan-input").focus();
  }
}

async function openScan() {
  scanReturnFocus = document.activeElement;
  scanOpen = true;
  scanShown = null;
  $("scan-input").value = "";
  $("scan-result").hidden = true;
  $("scan-sheet").hidden = false;
  document.body.classList.add("drawer-open");
  $("scan-close").focus();
  await startCamera();
}

function closeScan() {
  scanOpen = false;
  scanRun++;
  stopCamera();
  $("scan-sheet").hidden = true;
  document.body.classList.remove("drawer-open");
  if (scanReturnFocus?.isConnected) scanReturnFocus.focus();
}

// The camera, or the typing box when there is none, ready for the next buyer.
function scanNext() {
  scanSkip = { id: scanShown?.invoiceId ?? null, until: Date.now() + SCAN_SKIP_MS };
  scanShown = null;
  $("scan-result").hidden = true;
  $("scan-input").value = "";
  if (scanCameraProblem) {
    scanSay(scanCameraProblem);
    return $("scan-input").focus();
  }
  $("scan-close").focus();
  if (!scanStream) return startCamera();
  $("scan-camera").hidden = false;
  $("scan-video").play().catch(() => {});
  scanSay(SCAN_LOOKING);
  stopReading();
  readFrame();
}

const scanAction = (id, label, ghost = false) => Object.assign(el("button", ghost ? "ghost" : "", label), { type: "button", id });

// The big answer. The camera steps aside for it (and stays on, so the next scan starts at once).
function showScanBox(kind, words, lines = [], buttons = []) {
  if (!scanOpen) return;
  stopReading();
  const box = $("scan-result");
  box.className = `scan-result ${kind}`;
  const mark = el("span", "icon-circle");
  mark.append(icon(kind === "is-paid" ? "circle-check" : "triangle-alert"));
  const head = el("div", "scan-head-line");
  head.append(mark, Object.assign(el("h3", "scan-words", words), { id: "scan-words" }));
  const actions = el("div", "scan-actions");
  actions.append(...buttons, scanAction("scan-next", "Scan next", true));
  box.replaceChildren(head, ...lines.filter(Boolean), actions);
  box.hidden = false;
  $("scan-camera").hidden = true;
  scanSay("");
  box.querySelector("button").focus();
}

function showScanResult(reply) {
  scanShown = reply;
  if (reply.paid) {
    const amount = el("p", "scan-detail", formatMoney(reply.total));
    if (reply.collected) return showScanBox("is-paid", reply.title, [amount, statusTag("Collected")], [scanAction("scan-undo", "Undo", true)]);
    return showScanBox("is-paid", reply.title, [amount], [scanAction("scan-collected", "Collected")]);
  }
  const hint = {
    unpaid: reply.cached ? "PayPal was asked a few seconds ago. If they just paid, check again in a moment." : "",
    "part-paid": "Record the rest in PayPal itself.",
    cancelled: "Don't hand this order over.",
    unknown: "Please check again before handing the order over.",
  }[reply.state];
  const again = scanAction("scan-again", "Check again", true);
  const buttons = reply.state === "unpaid" ? [scanAction("scan-cash", "Record cash"), again] : reply.state === "cancelled" ? [] : [again];
  showScanBox("is-check", reply.title, [el("p", "scan-detail", reply.detail), hint && el("p", "hint", hint)], buttons);
}

// Every reply carries the whole table, so the page behind the sheet is right when it closes.
function showPickupTable(reply) {
  if (reply.batch !== batch) return showServerTable(reply);
  showOrders(reply);
  if (reply.changed?.length) flashPaid(reply.changed);
}

async function checkPickup(ref) {
  if (scanChecking) return;
  scanChecking = true;
  stopReading();
  scanSay("Checking with PayPal...");
  try {
    const reply = await postJson("/api/pickup/check", { invoiceId: ref });
    if (reply.notInOrders) {
      const here = await tableStillHere();
      showScanBox("is-check", here ? reply.notice : TABLE_CLEARED, here ? [el("p", "hint", OTHER_BROWSER)] : []);
    } else if (reply.notice) showScanBox("is-check", reply.notice);
    else {
      showPickupTable(reply);
      showScanResult(reply);
    }
  } catch (err) {
    showScanBox("is-check", `Couldn't reach the server (${err.message}).`);
  } finally {
    scanChecking = false;
  }
}

// The typing box: an id, a number or a pasted link; the same check as a scan.
async function checkTyped(event) {
  event.preventDefault();
  const text = $("scan-input").value;
  if (!text.trim()) return;
  try {
    scanner ??= await loadScanner();
  } catch {
    return showScanBox("is-check", "The scanner could not load. Check the connection, then try again.");
  }
  if (openPairLink(text)) return;
  const ref = scanner.invoiceRefFromTyped(text);
  if (ref) checkPickup(ref);
  else showScanBox("is-check", scanner.NOT_OUR_QR);
}

async function saveCollected(undo) {
  try {
    const reply = await postJson("/api/pickup/collected", { invoiceId: scanShown.invoiceId, ...(undo && { undo: true }) });
    if (reply.notice) return showScanBox("is-check", reply.notice);
    showPickupTable(reply);
    showScanResult(reply);
  } catch (err) {
    showScanBox("is-check", `That was not saved (${err.message}).`);
  }
}

// The shortcut to the same Record cash as the drawer: same server route, same words, full amount only.
async function scanRecordCash(button) {
  const { buyer, total, invoiceId } = scanShown;
  if (recording || !window.confirm(`Record ${formatMoney(total)} paid by cash for ${buyer}? It is saved in PayPal and can't be undone here.`)) return;
  recording = true;
  button.disabled = true;
  button.textContent = "Recording...";
  try {
    const reply = await postJson(`/api/invoices/${encodeURIComponent(invoiceId)}/payment`, { method: "CASH" });
    if (reply.notice) return showScanBox("is-check", reply.notice);
    if (reply.failed) throw new Error(reply.failed);
    showOrders(reply);
    flashPaid([{ buyer, to: "Paid (cash/bank)" }]);
    await checkPickup(invoiceId);
  } catch (err) {
    showScanBox("is-check", `The payment was not recorded (${err.message}).`);
  } finally {
    recording = false;
  }
}

// In the drawer: the mark can be taken back there too, for a tap on the wrong buyer.
function collectedCard(data) {
  if (!data.collected) return null;
  const card = el("section", "edit-card collected-card");
  const undo = Object.assign(el("button", "ghost small", "Undo"), { type: "button", id: "undo-collected" });
  undo.dataset.invoice = data.rows.find((row) => row.invoiceId)?.invoiceId ?? "";
  undo.setAttribute("aria-label", `Undo Collected for ${data.buyer}`);
  card.append(el("p", "hint", "Handed over at pickup. This is ChatChing's own note; PayPal isn't told."), undo);
  return card;
}

async function undoCollected(button) {
  button.disabled = true;
  hideError("drawer-error");
  try {
    const reply = await postJson("/api/pickup/collected", { invoiceId: button.dataset.invoice, undo: true });
    if (reply.notice) {
      if (!(await tableStillHere())) return;
      showError(reply.notice, "drawer-error");
      return renderDrawer();
    }
    showOrders(reply);
    $("drawer-close").focus();
  } catch (err) {
    showError(`That was not saved (${err.message}).`, "drawer-error");
    renderDrawer();
  }
}

// Same limit and words as src/paste.js. Checked here too, so a huge paste is never sent at all
// (over 100 KB the server refuses the request, and the browser logs that as a red error).
const MAX_CHARS = 15_000;
let reading = false; // one parse at a time: the button is disabled while the server reads
const STAGE_WORDS = { reading: "Reading the chats... Long chats can take up to a minute.", backup: "The AI is busy, trying the backup..." };

// "AI calls left today: 37" in the top bar (the server's daily counter, src/usage.js).
function showCallsLeft(left) {
  $("ai-calls-text").textContent = `AI calls left today: ${left ?? "…"}`;
}

// While the server reads, ask it once a second which step it is on (no timer guessing: the words change
// only when the server really moved to the backup model). A failed check just keeps the words as they are.
async function checkReading(say) {
  try {
    const res = await fetch("/api/parse/progress");
    if (!res.ok) return;
    const progress = await res.json();
    showCallsLeft(progress.aiCallsLeft);
    if (reading && progress.reading && STAGE_WORDS[progress.stage]) say(STAGE_WORDS[progress.stage]);
  } catch {}
}

// "Read orders": the chats + Chat date go to the server, which replies with the new rows, or with a
// friendly notice (too long, mock mode doesn't know these chats) that leaves the rows as they are.
// A notice about the AI (busy, too slow, used up) offers "Read without AI" (Step 10): withoutAi reads the
// same chats with simple rules on the server, no AI call. Only when the seller clicks it.
async function readOrders({ withoutAi = false } = {}) {
  if (reading) return;
  const text = $("chat").value;
  const say = (message) => ($("read-message").textContent = message);
  if (!text.trim()) return say("Paste some chat messages first.");
  if (text.length > MAX_CHARS) {
    return say(`That paste is ${text.length.toLocaleString("en")} characters. ChatChing reads up to ${MAX_CHARS.toLocaleString("en")} at a time, so please paste fewer messages.`);
  }
  if (!$("chat-date").value) return say("Choose the Chat date (the day these chats are from) first.");

  reading = true;
  const button = $("read-orders");
  const without = $("read-without-ai");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  without.hidden = true;
  hideError();
  say(withoutAi ? "Reading without AI..." : STAGE_WORDS.reading);
  const poll = withoutAi ? null : setInterval(() => checkReading(say), 1000);
  try {
    const res = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, chatDate: $("chat-date").value, ...(withoutAi && { withoutAi: true }) }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) {
      say(reply.notice);
      without.hidden = !reply.readWithoutAi;
    } else {
      say("");
      showOrders(reply);
      $("chat-edit").focus(); // the chat box folded away: keep keyboard focus on the slim bar
    }
  } catch (err) {
    say("");
    showError(`The orders could not be read (${err.message}).`);
  } finally {
    clearInterval(poll);
    reading = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    checkReading(say); // the counter after this read (failed calls count too)
  }
}

// The progress bar: done of total, from real replies only.
function showProgress(done, total) {
  const bar = $("send-progress");
  bar.hidden = total === 0;
  bar.setAttribute("aria-valuemax", String(total));
  bar.setAttribute("aria-valuenow", String(done));
  bar.firstElementChild.style.width = `${total ? (done / total) * 100 : 0}%`;
}

// "Send invoices": ONE buyer at a time, each a separate request to the server, so the bar and the words
// ("Sending invoice 3 of 7...") move only when an invoice is really done; no timer. A buyer that fails
// gets the amber "Error:" words on their row and the others carry on. The server's guards are the same
// as ever (per-buyer lock, invoice-exists check, duplicate-number lookup, batch rule).
async function sendInvoices() {
  const queue = buyerRows().filter((row) => row.toSend).map((row) => row.buyer);
  if (sending || !paypalReady || !queue.length) return;
  const needCheck = buyerRows().filter((row) => row.unclear && !row.cancelled).map((row) => row.buyer);
  const total = queue.length;
  const say = (message) => ($("send-message").textContent = message);
  let sent = 0;
  let failed = 0;
  let stopped = "";
  sending = true;
  sendErrors = new Map();
  hideError();
  showProgress(0, total);
  say(`Sending invoice 1 of ${total}...`);
  if (!(await tableStillHere())) {
    sending = false;
    return showSendButtons();
  }
  for (const [done, buyer] of queue.entries()) {
    sendProgress = { done, total };
    say(`Sending invoice ${done + 1} of ${total}...`);
    showSendButtons();
    try {
      const res = await fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyer }) });
      const reply = await res.json();
      if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
      if (reply.notice) {
        stopped = reply.notice; // e.g. orders are being read right now: stop, nothing half-done
        break;
      }
      if (reply.failed.length) {
        failed++;
        sendErrors.set(buyer.trim().toLowerCase(), reply.failed[0].reason);
      } else sent++; // sent now, or already invoiced (another tab got there first)
      // The row gets its link as soon as it's done; only that row is redrawn.
      totals = reply.totals;
      summary = reply.summary;
      groups = reply.groups;
      texts = textMap(reply.texts);
      rowsById = new Map(reply.orders.map((row) => [row.id, row]));
      showSummary();
      showStep(reply.orders);
      refreshTable(buyerRows().find((row) => row.buyer === buyer)?.id);
    } catch (err) {
      failed++;
      sendErrors.set(buyer.trim().toLowerCase(), err.message);
    }
    showProgress(done + 1, total);
  }
  sending = false;
  sendProgress = null;
  refreshTable(); // the amber Error: rows, and the button's new label
  if (sent) startPolling();
  if (stopped) return say(stopped);
  say([
    failed ? `${sent} of ${total} sent, ${failed} ${failed === 1 ? "needs" : "need"} a retry.` : `${sent} of ${total} sent. Copy each payer link into the chat.`,
    needCheck.length ? `Not sent: ${needCheck.join(", ")} (${needCheck.length === 1 ? "needs" : "need"} a check first).` : "",
  ].filter(Boolean).join(" "));
}

// "New batch": the server saves this batch (rows + invoice links) and starts an empty table, so the
// next day's chats can be read without losing or re-sending any invoice.
async function newBatch() {
  if (!window.confirm("Start a new batch? These orders and their payer links are saved, and the table starts empty.")) return;
  hideError();
  try {
    const res = await fetch("/api/new-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) return ($("read-message").textContent = reply.notice);
    $("chat").value = "";
    $("read-message").textContent = "";
    $("read-without-ai").hidden = true;
    $("send-message").textContent = "";
    sendErrors = new Map();
    showProgress(0, 0);
    showOrders(reply);
    $("chat").focus();
  } catch (err) {
    showError(`A new batch could not be started (${err.message}).`);
  }
}

// "Load demo": fill the chat box with the demo chats and their Chat date (2026-10-28). It doesn't read
// them: the judge clicks Read orders and sees the AI step (the saved Gemini reply, 0 AI calls). Once
// invoices are sent the server says to start a new batch first, exactly like Read orders.
async function loadDemo() {
  const say = (message) => ($("read-message").textContent = message);
  try {
    const res = await fetch("/api/demo");
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) return say(reply.notice);
    $("chat").value = reply.text;
    $("chat-date").value = reply.chatDate;
    $("read-without-ai").hidden = true;
    say(`Demo chats loaded: ${plural(reply.messages, "message")} from ${formatDate(reply.chatDate)}. Click Read orders.`);
    $("read-orders").focus();
  } catch (err) {
    showError(`The demo chats could not be loaded (${err.message}).`);
  }
}

// "Reset demo": the server empties this visitor's table so their demo can start over.
// Only this visitor's table. Nothing in PayPal is deleted or cancelled; sent invoices stay in the visitor's file.
async function resetDemo() {
  if (!window.confirm("Reset the demo? The table empties so you can start over. Nothing in PayPal is deleted or cancelled.")) return;
  hideError();
  try {
    const res = await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) return showError(reply.notice);
    stopPolling();
    closeDrawer();
    for (const id of ["read-message", "send-message", "status-message"]) $(id).textContent = "";
    $("read-without-ai").hidden = true;
    sendErrors = new Map();
    showProgress(0, 0);
    $("chat").value = "";
    showOrders(reply);
    scrollTo(0, 0);
    $("chat").focus();
  } catch (err) {
    showError(`The demo could not be reset (${err.message}).`);
  }
}

// Copy text for a chat or notes app. The clipboard API needs a secure page (https or localhost);
// elsewhere the older copy command is the fallback.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
}

// [{ buyer, message, reminder, question }] from the server -> buyer (lowercase) -> texts.
const textMap = (list) => new Map((list ?? []).map((t) => [String(t.buyer).trim().toLowerCase(), t]));

async function copyBuyerText(button) {
  const text = texts.get(button.dataset.buyer)?.[button.dataset.kind];
  if (!text) return;
  await copyText(text);
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = COPY_LABELS[button.dataset.kind]), 2000);
}

async function copyLink(button) {
  await copyText(button.dataset.link);
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = "Copy link"), 2000);
}

// The kitchen list as plain text, built by the server (one line per item), so it pastes cleanly.
async function copyKitchen(button) {
  await copyText(kitchen.text);
  button.replaceChildren(icon("check"), "Copied");
  setTimeout(() => button.isConnected && button.replaceChildren(icon("copy"), "Copy"), 2000);
}

$("chat-date").value = todayLocal();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !sending && !reading) tableStillHere();
  if (!scanOpen) return;
  // The phone was put away with the sheet open: the camera goes off, and comes back only when wanted.
  if (document.visibilityState === "hidden") {
    scanRun++;
    stopCamera();
  } else if (!scanCameraProblem && $("scan-result").hidden) startCamera();
});
for (const button of document.querySelectorAll("[data-pickup-scan]")) button.addEventListener("click", openScan);
$("scan-close").addEventListener("click", closeScan);
$("scan-sheet").addEventListener("keydown", (event) => drawerKeys(event, $("scan-sheet"), closeScan));
$("scan-typed").addEventListener("submit", checkTyped);
$("scan-result").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.id === "scan-next") scanNext();
  if (button?.id === "scan-again") checkPickup(scanShown.invoiceId);
  if (button?.id === "scan-cash") scanRecordCash(button);
  if (button?.id === "scan-collected") saveCollected(false);
  if (button?.id === "scan-undo") saveCollected(true);
});
$("read-orders").addEventListener("click", () => readOrders());
$("read-without-ai").addEventListener("click", () => readOrders({ withoutAi: true }));
for (const button of document.querySelectorAll("[data-send-invoices]")) button.addEventListener("click", sendInvoices);
for (const button of document.querySelectorAll("[data-new-batch]")) button.addEventListener("click", newBatch);
$("refresh-status").addEventListener("click", () => refreshStatus({ byHand: true }));
$("reset-demo").addEventListener("click", resetDemo);
$("load-demo").addEventListener("click", loadDemo);
$("grid").addEventListener("click", (event) => {
  const copy = event.target.closest(".copy-link");
  if (copy) copyLink(copy);
  const words = event.target.closest(".copy-text");
  if (words) copyBuyerText(words);
});
$("chat-edit").addEventListener("click", () => {
  foldChats(false);
  $("chat").focus();
});
$("chat-hide").addEventListener("click", () => {
  foldChats(true);
  $("chat-edit").focus();
});
$("stat-check").addEventListener("click", () => setNeedsCheckFilter(!onlyNeedsCheck));
$("filter-clear").addEventListener("click", () => {
  setNeedsCheckFilter(false);
  $("stat-check").focus();
});
$("search").addEventListener("input", (event) => grid?.setGridOption("quickFilterText", event.target.value));
$("export-csv").addEventListener("click", exportCsv);
$("kitchen-list").addEventListener("click", openKitchen);
$("open-on-phone").addEventListener("click", openPairing);
$("page-prev").addEventListener("click", () => grid?.paginationGoToPreviousPage());
$("page-next").addEventListener("click", () => grid?.paginationGoToNextPage());
$("drawer-close").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("drawer").addEventListener("keydown", drawerKeys);
$("drawer-body").addEventListener("click", (event) => {
  if (event.target.closest("#record-payment")) recordPayment(event.target.closest("#record-payment"));
  if (event.target.closest(".keep-price")) keepMenuPrice(event.target.closest(".keep-price"));
  if (event.target.closest("#send-anyway")) changeItems("POST", `/api/buyers/${encodeURIComponent(openGroupId)}/send-anyway`);
  if (event.target.closest("#copy-kitchen")) copyKitchen(event.target.closest("#copy-kitchen"));
  if (event.target.closest(".copy-text")) copyBuyerText(event.target.closest(".copy-text"));
  if (event.target.closest(".remove-item")) removeItem(event.target.closest(".remove-item"));
  if (event.target.closest("#add-item")) addItem();
  if (event.target.closest("#undo-collected")) undoCollected(event.target.closest("#undo-collected"));
  if (event.target.closest("#save-qr")) saveQr(event.target.closest("#save-qr"));
  if (event.target.closest("#pair-new")) newPairLink();
});
$("drawer-body").addEventListener("change", (event) => {
  if (event.target.dataset.field) saveField(event.target);
});
// The chat box can be collapsed on iPad and phone; on a laptop it always stays open.
laptop.addEventListener("change", () => {
  if (laptop.matches) $("chats").open = true;
  fitToWidth();
});
phone.addEventListener("change", fitToWidth);
// The chat box opening or folding changes the table's width without any screen change. Checked on the next
// frame, and only a change of column set redraws, so the observer never loops.
new ResizeObserver(() => requestAnimationFrame(() => {
  if (grid && chooseLayout() !== layout) fitToWidth();
})).observe($("grid"));

// Draw the static icons (<i data-lucide>). Without the library the page still works, just without icons.
if (window.lucide) window.lucide.createIcons({ icons: window.lucide.icons });
else console.info("Lucide icons did not load; the page works without them.");
showStep([]);
grid = createOrdersGrid();
loadState();
