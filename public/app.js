// The page: the orders table (AG Grid) with editing (Step 2). Every edit goes to the server, which
// recalculates the price, total and unclear flag; the page never does money maths.
// Layout and colours follow the UI spec (PLAN.md Section 12). Reading orders comes in Step 4.

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

// Only active order rows can be edited; the pinned totals row and cancelled rows can't.
const canEdit = (p) => !p.node.rowPinned && p.data.orderStatus === "active";
const itemName = (id) => menuItems.find((item) => item.id === id)?.name ?? "—";
const ordersText = (n) => `${n} ${n === 1 ? "order" : "orders"} ready`;

// Status badge: soft tint, navy text. A cancelled order shows "Cancelled".
function statusBadge(p) {
  if (p.node.rowPinned) return "";
  const label = p.data.orderStatus === "cancelled" ? "Cancelled" : p.value;
  const badge = document.createElement("span");
  badge.className = `badge badge-${String(label).toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`;
  badge.textContent = label;
  return badge;
}

// The columns. Phones get narrower minimum widths and only Buyer, Item, Total, Status.
function columns(isPhone) {
  const narrow = (wide, small) => (isPhone ? small : wide);
  return [
    { field: "buyer", headerName: "Buyer", cellDataType: "text", minWidth: narrow(90, 72), wrapText: true, autoHeight: true },
    {
      field: "itemId", headerName: "Item", cellDataType: "text", flex: 2, minWidth: narrow(120, 100),
      wrapText: true, autoHeight: true, editable: canEdit,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: () => ({ values: menuItems.map((item) => item.id) }),
      // The select editor shows its options through this formatter too, so the seller sees names.
      valueFormatter: (p) => (p.node?.rowPinned ? ordersText(totals.orders) : itemName(p.value)),
    },
    {
      field: "qty", headerName: "Qty", cellDataType: "number", type: "rightAligned", minWidth: 64, maxWidth: 96, hide: isPhone,
      editable: canEdit, cellEditor: "agNumberCellEditor", cellEditorParams: { min: 1, max: 99, precision: 0 },
      valueFormatter: (p) => (p.value == null ? (p.node?.rowPinned ? "" : "—") : String(p.value)),
    },
    {
      field: "deliveryDate", headerName: "Date", cellDataType: "dateString", minWidth: 116, hide: isPhone,
      editable: canEdit, cellEditor: "agDateStringCellEditor",
      valueFormatter: (p) => (p.node?.rowPinned ? "" : formatDate(p.value)),
    },
    {
      // "rightAligned" gives the cell the class ag-right-aligned-cell; listed again here because cellClass replaces it.
      field: "lineTotal", headerName: "Total", cellDataType: "text", type: "rightAligned", minWidth: narrow(116, 92),
      cellClass: ["money", "ag-right-aligned-cell"], valueFormatter: (p) => (p.value == null ? "—" : formatMoney(p.value)),
    },
    { field: "invoiceStatus", headerName: "Status", cellDataType: "text", minWidth: 92, cellRenderer: statusBadge },
    {
      colId: "check", headerName: "Check", cellDataType: "text", flex: 3, minWidth: 130, wrapText: true, autoHeight: true, hide: isPhone,
      valueGetter: (p) => (p.data?.unclear && p.data.orderStatus === "active" ? `Check: ${p.data.reason}` : ""),
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
    rowHeight: 48, // at least 44 px to tap
    headerHeight: 44,
    wrapperBorderRadius: 8,
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
    grid.applyTransaction({ update: [reply.row] });
    showTotals();
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
    $("status").textContent = [
      `${menuItems.length} menu items (${currency})`,
      `AI mode: ${state.aiMode}`,
      `PayPal keys: ${state.paypalConfigured ? "set" : "missing"}`,
      `Gemini key: ${state.geminiConfigured ? "set" : "missing"}`,
    ].join(" - ");
    for (const row of state.orders) saved.set(row.id, structuredClone(row));
    showStep(state.orders);
    if (grid) {
      grid.setGridOption("rowData", state.orders);
      fitToWidth();
    }
  } catch (err) {
    $("status").textContent = "";
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

showStep([]);
grid = createOrdersGrid();
loadState();
