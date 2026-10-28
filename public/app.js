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
const laptop = window.matchMedia("(min-width: 1024px)");

const $ = (id) => document.getElementById(id);

// Filled in from /api/state: the currency and menu come from data/menu.json, never from the code.
let currency = null;
let menuItems = [];
let grid = null;
let totals = { orders: 0, total: "0.00" };
let summary = null;
let source = null; // the chats the rows came from: { text, chatDate, messages }
let rowsById = new Map(); // the order rows (one per item), as the server last confirmed them
let groups = []; // buyer groups from the server: { buyer, rowIds, items, total, cancelled }
let openGroupId = null; // the buyer shown in the drawer (its first row id)
let onlyNeedsCheck = false; // the Needs check card filters the table to buyers that need a check
let chatDate = null; // for the CSV file name
let returnFocus = null;
let paypalReady = false; // both PayPal keys are set on the server
let sending = false; // invoices are being sent: the Send buttons wait
let checking = false; // a status check is on its way to the server
let pollTimer = null;
let pollUntil = 0;
const POLL_MS = 20_000; // PLAN.md Section 3: every 20 s while the page is open
const POLL_FOR_MS = 30 * 60_000; // then stop, so a forgotten tab doesn't ask PayPal all day

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
      payerLink, // set once the buyer's invoice is sent
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
  "Paid (cash/bank)": "banknote", "Cancelled/Refunded": "circle-x", Cancelled: "circle-x",
};

function statusTag(label) {
  const tag = el("span", `badge badge-${String(label).toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`);
  tag.append(icon(STATUS_ICONS[label] ?? "circle"), label);
  return tag;
}

// ---- Cell renderers (laptop + iPad) ----

function buyerCell(p) {
  if (p.node.rowPinned) return el("span", "pinned-label", "Total");
  const cell = el("span", "buyer");
  const text = el("span", "");
  // iPad has no Date column (no room), so the date sits under the name, as on the phone cards.
  const sub = screenSize() === "ipad" && !p.data.cancelled ? `${buyerSub(p.data)}, ${datesText(p.data)}` : buyerSub(p.data);
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
  const data = p.data;
  const card = el("span", "card-row");
  const top = el("span", "card-top");
  const who = el("span", "buyer");
  const text = el("span", "");
  text.append(el("span", "buyer-name", data.buyer || "No name"), el("span", "buyer-sub", `${buyerSub(data)}, ${datesText(data)}`));
  who.append(avatar(data.buyer), text);
  const right = el("span", "card-right");
  right.append(el("span", "card-total money", data.total == null ? "—" : formatMoney(data.total)), statusTag(data.status));
  top.append(who, right);
  card.append(top, chips(data));
  const words = checkText(data);
  if (words) card.append(el("span", "check-text", words));
  const link = payLink(data);
  if (link) card.append(link);
  return card;
}

// Every column always exists, so the search box and the CSV export work the same on every screen:
// phones show only the card column, wider screens hide it.
function columns(size) {
  const isPhone = size === "phone";
  const wide = size === "laptop";
  return [
    {
      colId: "card", headerName: "Buyers", flex: 1, autoHeight: true, wrapText: true, hide: !isPhone,
      cellClass: "card-cell", cellRenderer: cardCell,
      valueGetter: (p) => (p.node.rowPinned ? "" : `${p.data.buyer} ${itemsText(p.data)}`), // what the search box looks at
    },
    { colId: "buyer", field: "buyer", headerName: "Buyer", minWidth: wide ? 200 : 180, flex: 1, wrapText: true, autoHeight: true, hide: isPhone, cellRenderer: buyerCell },
    {
      colId: "items", headerName: "Items", minWidth: 220, flex: 2.4, autoHeight: true, wrapText: true, hide: isPhone, cellRenderer: itemsCell,
      // The totals row carries its own numbers, so AG Grid sees them change and redraws the cell.
      valueGetter: (p) => (p.node.rowPinned ? ordersText(p.data.orders) : itemsText(p.data)),
    },
    {
      colId: "date", headerName: "Date", minWidth: 130, flex: 0.8, wrapText: true, hide: !wide,
      valueGetter: (p) => (p.node.rowPinned ? "" : datesText(p.data)),
    },
    {
      colId: "total", headerName: "Total", type: "rightAligned", minWidth: 116, flex: 0.8, hide: isPhone,
      cellClass: ["money", "ag-right-aligned-cell"],
      valueGetter: (p) => (p.data.total == null ? "—" : formatMoney(p.data.total)),
    },
    {
      colId: "status", headerName: "Status", minWidth: wide ? 150 : 128, flex: 0.9, hide: isPhone,
      valueGetter: (p) => (p.node.rowPinned ? "" : p.data.status),
      cellRenderer: (p) => (p.node.rowPinned ? "" : statusTag(p.data.status)),
    },
    { colId: "open", headerName: "", width: 64, minWidth: 64, maxWidth: 64, hide: isPhone, cellClass: "open-cell", cellRenderer: openCell },
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
const screenSize = () => (phone.matches ? "phone" : laptop.matches ? "laptop" : "ipad");

// The pinned totals row (laptop + iPad) and the sticky bar (phone) both show the server's totals.
function showTotals() {
  if (!grid) return;
  grid.setGridOption("pinnedBottomRowData", phone.matches ? [] : [{ id: "totals", orders: totals.orders, total: totals.total }]);
  $("phone-sum").replaceChildren(el("span", "", `Total: ${ordersText(totals.orders)}`), el("span", "money", formatMoney(totals.total)));
}

// The Send invoices buttons (above the table; in the sticky bar on phones): "Send 7 invoices", or
// waiting while sending, or nothing to send. Missing PayPal keys: an amber note next to them instead.
function showSendButtons() {
  const count = buyerRows().filter((row) => row.toSend).length;
  for (const button of document.querySelectorAll("[data-send-invoices]")) {
    button.disabled = sending || !paypalReady || count === 0;
    button.toggleAttribute("aria-busy", sending);
    button.replaceChildren(icon("send"), sending ? "Sending..." : count ? `Send ${plural(count, "invoice")}` : "Send invoices");
  }
  $("send-warning").hidden = paypalReady || count === 0;
  // Once invoices exist, reading again is refused: New batch is the way on.
  const invoiced = [...rowsById.values()].some((row) => row.invoiceId);
  for (const button of document.querySelectorAll("[data-new-batch]")) button.hidden = !invoiced;
  $("refresh-status").hidden = !paypalReady || !invoiced;
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
    card.querySelector("[data-figure]").textContent = figure;
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
function showSetup(state) {
  const items = [
    `Menu: ${state.menu.items.length} items in ${currency}`,
    `AI mode: ${state.aiMode}`,
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

// Phone <-> wider: switch theme and columns.
function fitToWidth() {
  if (!grid) return;
  grid.updateGridOptions({ theme: phone.matches ? themes.phone : themes.wide, columnDefs: columns(screenSize()) });
  showTotals();
}

function refreshTable() {
  if (!grid) return;
  grid.setGridOption("rowData", buyerRows());
  grid.redrawRows(); // chips, check words and heights all follow the new data
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

function editCard(row) {
  const cancelled = row.orderStatus === "cancelled";
  const invoiced = Boolean(row.invoiceId); // the invoice must keep matching what PayPal has
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
  if (cancelled) card.append(el("p", "hint", "This order was cancelled in the chat, so it can't be changed."));
  else if (invoiced) card.append(el("p", "hint", "The invoice is sent, so this order can't be changed any more."));
  else if (row.unclear) card.append(el("p", "check-text", `Check: ${row.reason}`));
  return card;
}

function renderDrawer() {
  const data = buyerRows().find((row) => row.id === openGroupId);
  if (!data) return closeDrawer();
  $("drawer-avatar").textContent = initials(data.buyer);
  $("drawer-title").textContent = data.buyer || "No name";
  $("drawer-sub").textContent = data.cancelled ? "Cancelled order"
    : data.total == null ? "Needs a check before it can be invoiced"
    : `${plural(data.items, "item")}, ${formatMoney(data.total)} in total`;
  $("drawer-body").replaceChildren(...data.rows.map(editCard));
}

function openDrawer(id) {
  openGroupId = id;
  returnFocus = document.activeElement;
  hideError("drawer-error");
  renderDrawer();
  $("scrim").hidden = false;
  $("drawer").hidden = false;
  document.body.classList.add("drawer-open");
  requestAnimationFrame(() => $("drawer").classList.add("is-open"));
  ($("drawer-body").querySelector("select:not(:disabled), input:not(:disabled)") ?? $("drawer-close")).focus();
}

function closeDrawer() {
  openGroupId = null;
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
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [name]: value }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    rowsById.set(id, reply.row);
    totals = reply.totals;
    summary = reply.summary;
    groups = reply.groups;
    hideError("drawer-error");
  } catch (err) {
    showError(`That change was not saved (${err.message}).`, "drawer-error");
  }
  refreshTable();
  showSummary();
  renderDrawer();
  $(`edit-${id}-${name}`)?.focus();
}

// Keep Tab inside the open drawer, and Escape closes it.
function drawerKeys(event) {
  if (event.key === "Escape") return closeDrawer();
  if (event.key !== "Tab") return;
  const focusable = [...$("drawer").querySelectorAll("button, select, input")].filter((node) => !node.disabled);
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
  const api = agGrid.createGrid($("grid"), {
    theme: phone.matches ? themes.phone : themes.wide,
    columnDefs: columns(screenSize()),
    animateRows: false,
    defaultColDef: { sortable: false, resizable: false, suppressMovable: true, cellDataType: false },
    domLayout: "autoHeight", // the page scrolls, not a box inside it
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
      "row-unclear": (p) => !p.node.rowPinned && p.data?.unclear && !p.data.cancelled,
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
  chatDate = state.source?.chatDate ?? null;
  groups = state.groups;
  rowsById = new Map(state.orders.map((row) => [row.id, row]));
  showSummary();
  showSource();
  foldChats(Boolean(source && state.orders.length));
  showStep(state.orders);
  if (grid) {
    fitToWidth();
    refreshTable();
  }
  showSendButtons();
  if (openGroupId) renderDrawer();
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!res.ok) throw new Error(state.error ?? `HTTP ${res.status}`);
    currency = state.menu.currency;
    menuItems = state.menu.items;
    paypalReady = state.paypalConfigured;
    showSetup(state);
    $("ai-calls-text").textContent = `AI calls left today: ${state.aiCallsLeft}`;
    showOrders(state);
    if (hasOpenInvoices()) startPolling();
  } catch (err) {
    showError(`Can't reach the server (${err.message}). Is npm start running?`);
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
    if (reply.changed.length) {
      showOrders(reply);
      flashPaid(reply.changed);
    }
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

// Part 2 fills this in (the Paid flash).
function flashPaid() {}

// Same limit and words as src/paste.js. Checked here too, so a huge paste is never sent at all
// (over 100 KB the server refuses the request, and the browser logs that as a red error).
const MAX_CHARS = 10_000;
let reading = false; // one parse at a time: the button is disabled while the server reads

// "Read orders": the chats + Chat date go to the server, which replies with the new rows, or with a
// friendly notice (too long, mock mode doesn't know these chats) that leaves the rows as they are.
async function readOrders() {
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
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  hideError();
  say("Reading your messages... this can take up to a minute.");
  try {
    const res = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, chatDate: $("chat-date").value }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) say(reply.notice);
    else {
      say("");
      showOrders(reply);
      $("chat-edit").focus(); // the chat box folded away: keep keyboard focus on the slim bar
    }
  } catch (err) {
    say("");
    showError(`The orders could not be read (${err.message}).`);
  } finally {
    reading = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// "Send invoices": the server sends one PayPal sandbox invoice per clear buyer that has none yet, and
// replies with the updated rows plus who was sent, skipped or failed. One send at a time: the buttons
// wait, and the server's own guards make a double-click harmless anyway.
async function sendInvoices() {
  if (sending || !paypalReady) return;
  sending = true;
  showSendButtons();
  hideError();
  const say = (message) => ($("send-message").textContent = message);
  say("Sending invoices to PayPal...");
  try {
    const res = await fetch("/api/invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    if (reply.notice) return say(reply.notice);
    sending = false;
    showOrders(reply);
    if (reply.sent.length) startPolling();
    const needCheck = reply.skipped.filter((s) => s.reason === "Needs a check first.").map((s) => s.buyer);
    say([
      reply.sent.length ? `${plural(reply.sent.length, "invoice")} sent. Copy each payer link into the chat.` : "Nothing new to send.",
      needCheck.length ? `Not sent: ${needCheck.join(", ")} (${needCheck.length === 1 ? "needs" : "need"} a check first).` : "",
    ].filter(Boolean).join(" "));
    if (reply.failed.length) {
      showError(`${plural(reply.failed.length, "invoice")} could not be sent: ${reply.failed.map((f) => `${f.buyer} (${f.reason})`).join("; ")} Click Send again to retry.`);
    }
  } catch (err) {
    say("");
    showError(`The invoices could not be sent (${err.message}).`);
  } finally {
    sending = false;
    showSendButtons();
  }
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
    $("send-message").textContent = "";
    showOrders(reply);
    $("chat").focus();
  } catch (err) {
    showError(`A new batch could not be started (${err.message}).`);
  }
}

// Copy a payer link for the chat. The clipboard API needs a secure page (https or localhost);
// elsewhere the older copy command is the fallback.
async function copyLink(button) {
  const link = button.dataset.link;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: link });
    document.body.append(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = "Copy link"), 2000);
}

$("chat-date").value = todayLocal();
$("read-orders").addEventListener("click", readOrders);
for (const button of document.querySelectorAll("[data-send-invoices]")) button.addEventListener("click", sendInvoices);
for (const button of document.querySelectorAll("[data-new-batch]")) button.addEventListener("click", newBatch);
$("refresh-status").addEventListener("click", () => refreshStatus({ byHand: true }));
$("grid").addEventListener("click", (event) => {
  const copy = event.target.closest(".copy-link");
  if (copy) copyLink(copy);
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
$("page-prev").addEventListener("click", () => grid?.paginationGoToPreviousPage());
$("page-next").addEventListener("click", () => grid?.paginationGoToNextPage());
$("drawer-close").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("drawer").addEventListener("keydown", drawerKeys);
$("drawer-body").addEventListener("change", (event) => {
  if (event.target.dataset.field) saveField(event.target);
});
// The chat box can be collapsed on iPad and phone; on a laptop it always stays open.
laptop.addEventListener("change", () => {
  if (laptop.matches) $("chats").open = true;
  fitToWidth();
});
phone.addEventListener("change", fitToWidth);

// Draw the static icons (<i data-lucide>). Without the library the page still works, just without icons.
if (window.lucide) window.lucide.createIcons({ icons: window.lucide.icons });
else console.info("Lucide icons did not load; the page works without them.");
showStep([]);
grid = createOrdersGrid();
loadState();
