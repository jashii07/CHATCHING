// The page: the orders table (AG Grid) with editing (Step 2). Every edit goes to the server, which
// recalculates the price, total and unclear flag; the page never does money maths.
// Layout and colours follow the UI spec (PLAN.md Section 12). Reading orders comes in Step 4.
// Icons: Lucide (pinned in index.html). Static icons are <i data-lucide="..."> tags; badges build theirs in code.

// The AG Grid features later steps rely on (all Community, none Enterprise).
const NEEDED_MODULES = {
  CsvExportModule: "CSV export",
  HighlightChangesModule: "cell flashing",
  QuickFilterModule: "quick filter",
};

const phone = window.matchMedia("(max-width: 640px)");
const laptop = window.matchMedia("(min-width: 1024px)");

const $ = (id) => document.getElementById(id);

// Filled in from /api/state: the currency and menu come from data/menu.json, never from the code.
let currency = null;
let menuItems = [];
let grid = null;
let totals = { orders: 0, total: "0.00" };
let summary = null;
// The last rows the server confirmed, by id. AG Grid changes its own copy while editing,
// so a refused edit is undone from here.
const saved = new Map();

// "54.00" -> "RM 54.00" (MYR) or "$54.00" (USD). Same Intl options as formatMoney in src/money.js.
function formatMoney(amount) {
  if (amount == null || !currency) return amount ?? "";
  return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(Number(amount));
}

// "2026-10-31" -> "Sat 31 Oct". UTC, so the seller's time zone can't shift the day.
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// Today in the seller's own time zone (toISOString() would give the UTC date).
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function showError(message) {
  $("error").textContent = `Error: ${message}`;
  $("error").hidden = false;
}

function hideError() {
  $("error").hidden = true;
}

// A Lucide icon as an <svg>, or nothing if the icon library didn't load (the words still show).
function icon(name) {
  const node = window.lucide?.icons?.[name];
  if (!node) return document.createTextNode("");
  const svg = window.lucide.createElement(node);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("lucide");
  return svg;
}

// Only active order rows can be edited; the pinned totals row and cancelled rows can't.
const canEdit = (p) => !p.node.rowPinned && p.data.orderStatus === "active";
const itemName = (id) => menuItems.find((item) => item.id === id)?.name ?? "—";
const ordersText = (n) => `${n} ${n === 1 ? "order" : "orders"} ready`;

// One icon per status, so the badge reads at a glance (the words carry the meaning, not the icon).
const STATUS_ICONS = {
  Draft: "PencilLine", Sent: "Send", "Part paid": "Hourglass", Paid: "CircleCheck",
  "Paid (cash/bank)": "Banknote", "Cancelled/Refunded": "CircleX", Cancelled: "CircleX",
};

// Status badge: soft tint, navy text, an icon. A cancelled order shows "Cancelled".
function statusBadge(p) {
  if (p.node.rowPinned) return "";
  const label = p.data.orderStatus === "cancelled" ? "Cancelled" : p.value;
  const badge = document.createElement("span");
  badge.className = `badge badge-${String(label).toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`;
  badge.append(icon(STATUS_ICONS[label] ?? "Circle"), label);
  return badge;
}

// The words for an unclear row: "Check: <reason>", or "" when the row is fine.
const checkText = (data) => (data?.unclear && data.orderStatus === "active" ? `Check: ${data.reason}` : "");

// Phones hide the Check column, so the item cell carries the words under the item name:
// an amber row with no words only says "something's wrong", not what.
function itemWithCheck(p) {
  const words = p.node.rowPinned ? "" : checkText(p.data);
  if (!words) return p.valueFormatted;
  const cell = document.createElement("span");
  const check = Object.assign(document.createElement("span"), { className: "check-text check-under", textContent: words });
  cell.append(p.valueFormatted, check);
  return cell;
}

// The columns. Phones get narrower minimum widths and only Buyer, Item, Total, Status.
function columns(isPhone) {
  const narrow = (wide, small) => (isPhone ? small : wide);
  return [
    { field: "buyer", headerName: "Buyer", cellDataType: "text", minWidth: narrow(84, 72), wrapText: true, autoHeight: true },
    {
      field: "itemId", headerName: "Item", cellDataType: "text", flex: 2, minWidth: narrow(128, 100),
      wrapText: true, autoHeight: true, editable: canEdit,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: () => ({ values: menuItems.map((item) => item.id) }),
      // The select editor shows its options through this formatter too, so the seller sees names.
      valueFormatter: (p) => (p.node?.rowPinned ? ordersText(totals.orders) : itemName(p.value)),
      cellRenderer: isPhone ? itemWithCheck : undefined,
    },
    {
      field: "qty", headerName: "Qty", cellDataType: "number", type: "rightAligned", minWidth: 60, maxWidth: 88, hide: isPhone,
      editable: canEdit, cellEditor: "agNumberCellEditor", cellEditorParams: { min: 1, max: 99, precision: 0 },
      valueFormatter: (p) => (p.value == null ? (p.node?.rowPinned ? "" : "—") : String(p.value)),
    },
    {
      field: "deliveryDate", headerName: "Date", cellDataType: "dateString", minWidth: 112, hide: isPhone,
      editable: canEdit, cellEditor: "agDateStringCellEditor",
      valueFormatter: (p) => (p.node?.rowPinned ? "" : formatDate(p.value)),
    },
    {
      // "rightAligned" gives the cell the class ag-right-aligned-cell; listed again here because cellClass replaces it.
      field: "lineTotal", headerName: "Total", cellDataType: "text", type: "rightAligned", minWidth: narrow(108, 92),
      cellClass: ["money", "ag-right-aligned-cell"], valueFormatter: (p) => (p.value == null ? "—" : formatMoney(p.value)),
    },
    { field: "invoiceStatus", headerName: "Status", cellDataType: "text", minWidth: narrow(136, 104), cellRenderer: statusBadge },
    {
      colId: "check", headerName: "Check", cellDataType: "text", flex: 2, minWidth: 120, wrapText: true, autoHeight: true, hide: isPhone,
      valueGetter: (p) => checkText(p.data),
      cellClass: "check-text",
    },
  ];
}

// Quartz theme in the spec's colours. Names checked against the AG Grid 36.2.0 file itself.
function makeTheme(isPhone) {
  return agGrid.themeQuartz.withParams({
    backgroundColor: "#FFFFFF",
    foregroundColor: "#1F2A44",
    textColor: "#1F2A44",
    accentColor: "#1D4E9E",
    borderColor: "#E8E1D5",
    headerBackgroundColor: "#FBF7F0",
    headerTextColor: "#1F2A44",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 15,
    rowHoverColor: "#F7F1E6", // light warm tint, not blue: blue means clickable
    selectedRowBackgroundColor: "#F1E8D8",
    pinnedRowBackgroundColor: "#FBF7F0",
    rowHeight: 60, // roomy, and well over the 44 px tap minimum
    headerHeight: 52,
    headerFontWeight: 600,
    wrapperBorderRadius: 16,
    wrapperBorder: false, // the white panel is already the frame
    columnBorder: false,
    cellHorizontalPaddingScale: isPhone ? 0.5 : 1, // phones are narrow: less padding
  });
}

// Made once: a new theme object makes AG Grid redraw everything.
let themes = null;

const totalsRow = () => ({ id: "totals", buyer: "Total", itemId: null, qty: null, deliveryDate: null, lineTotal: totals.total });

// The pinned totals row (laptop + iPad) and the sticky bar (phone) both show the server's totals.
function showTotals() {
  if (!grid) return;
  grid.setGridOption("pinnedBottomRowData", phone.matches ? [] : [totalsRow()]);
  $("phone-total").replaceChildren(
    Object.assign(document.createElement("span"), { textContent: `Total: ${ordersText(totals.orders)}` }),
    Object.assign(document.createElement("span"), { className: "money", textContent: formatMoney(totals.total) }),
  );
}

// The four summary cards. Figures come from the server (no money maths here); the cards turn
// amber when an order needs checking and green when money has arrived.
function showSummary() {
  if (!summary) return;
  const set = (id, figure, caption, state) => {
    const card = $(id);
    card.querySelector("[data-figure]").textContent = figure;
    card.querySelector("[data-caption]").textContent = caption;
    card.classList.remove("is-check", "is-paid");
    if (state) card.classList.add(state);
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  set("stat-orders", String(summary.orders), summary.orders ? "One per buyer, cancelled ones left out" : "Paste chats to start");
  set("stat-expected", formatMoney(summary.expected), `From ${plural(summary.ready, "order")} ready to invoice`);
  set("stat-paid", formatMoney(summary.paid), summary.paidOrders ? `From ${plural(summary.paidOrders, "order")}` : "Nothing paid yet", summary.paidOrders ? "is-paid" : "");
  set("stat-check", String(summary.needsCheck), summary.needsCheck ? `${plural(summary.needsCheck, "order")} to fix below` : "All clear", summary.needsCheck ? "is-check" : "");
}

// Quiet setup details under the title, one chip each.
function showMeta(state) {
  const items = [
    `Menu: ${state.menu.items.length} items in ${currency}`,
    `AI: ${state.aiMode} mode`,
    `PayPal: ${state.paypalConfigured ? "connected" : "keys missing"}`,
    `Gemini: ${state.geminiConfigured ? "connected" : "key missing"}`,
  ];
  $("meta").replaceChildren(...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
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

// Phone <-> wider: switch theme and columns. Wrapped rows (autoHeight) measure themselves again.
function fitToWidth() {
  if (!grid) return;
  grid.updateGridOptions({ theme: phone.matches ? themes.phone : themes.wide, columnDefs: columns(phone.matches) });
  showTotals();
}

// One edited cell -> PUT /api/orders/:id. The server's reply (price, total, unclear flag) replaces
// the row; if the server refuses the edit, the row goes back to how it was and the reason is shown.
async function saveEdit(p) {
  const field = p.colDef.field;
  if (p.newValue === p.oldValue) return;
  const id = p.data.id;
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: p.newValue ?? null }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    saved.set(id, structuredClone(reply.row));
    totals = reply.totals;
    summary = reply.summary;
    grid.applyTransaction({ update: [reply.row] });
    showTotals();
    showSummary();
    hideError();
  } catch (err) {
    grid.applyTransaction({ update: [structuredClone(saved.get(id))] });
    showError(`That change was not saved (${err.message}).`);
  }
}

function createOrdersGrid() {
  if (typeof agGrid === "undefined") {
    showError("The table library (AG Grid) could not load. Check the internet connection and reload.");
    return null;
  }
  themes = { wide: makeTheme(false), phone: makeTheme(true) };
  const api = agGrid.createGrid($("grid"), {
    theme: phone.matches ? themes.phone : themes.wide,
    columnDefs: columns(phone.matches),
    animateRows: false, // rows jump straight to their new height; sliding added nothing here
    defaultColDef: { flex: 1, sortable: false, suppressMovable: true },
    domLayout: "autoHeight", // the page scrolls, not a box inside it
    rowData: [],
    getRowId: (p) => p.data.id,
    rowClassRules: {
      "row-unclear": (p) => !p.node.rowPinned && p.data?.orderStatus === "active" && p.data.unclear,
      "row-cancelled": (p) => p.data?.orderStatus === "cancelled",
    },
    singleClickEdit: true,
    stopEditingWhenCellsLoseFocus: true,
    onCellValueChanged: saveEdit,
    localeText: { noRowsToShow: "No orders yet. Paste chats and click Read orders." },
  });
  const missing = Object.keys(NEEDED_MODULES).filter((name) => !api.isModuleRegistered(name));
  if (missing.length) console.error(`AG Grid is missing: ${missing.map((name) => NEEDED_MODULES[name]).join(", ")}`);
  return api;
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!res.ok) throw new Error(state.error ?? `HTTP ${res.status}`);
    currency = state.menu.currency;
    menuItems = state.menu.items;
    totals = state.totals;
    summary = state.summary;
    showMeta(state);
    showSummary();
    $("ai-calls-text").textContent = `AI calls left today: ${state.aiCallsLeft}`;
    for (const row of state.orders) saved.set(row.id, structuredClone(row));
    showStep(state.orders);
    if (grid) {
      grid.setGridOption("rowData", state.orders);
      fitToWidth();
    }
  } catch (err) {
    $("meta").replaceChildren();
    showError(`Can't reach the server (${err.message}). Is npm start running?`);
  }
}

$("chat-date").value = todayLocal();
$("read-orders").addEventListener("click", () => {
  $("read-message").textContent = "Coming soon: reading orders is built in Step 4.";
});
// The chat box can be collapsed on iPad and phone; on a laptop it always stays open.
laptop.addEventListener("change", () => {
  if (laptop.matches) $("chats").open = true;
});
phone.addEventListener("change", fitToWidth);

// Draw the static icons (<i data-lucide>). Without the library the page still works, just without icons.
if (window.lucide) window.lucide.createIcons({ icons: window.lucide.icons });
else console.info("Lucide icons did not load; the page works without them.");
showStep([]);
grid = createOrdersGrid();
loadState();
