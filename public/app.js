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
// "laptop" (>= 1024 px), "ipad" (641-1023 px) or "phone" (<= 640 px): each gets its own column widths.
const screenSize = () => (phone.matches ? "phone" : laptop.matches ? "laptop" : "ipad");

const $ = (id) => document.getElementById(id);

// Filled in from /api/state: the currency and menu come from data/menu.json, never from the code.
let currency = null;
let menuItems = [];
let grid = null;
let totals = { orders: 0, total: "0.00" };
let summary = null;
let source = null; // the chats the rows came from: { text, chatDate, messages }
let rowsById = new Map();
// Buyer groups from the server, and for each row: is it the first of its buyer, and which group.
let groupOf = new Map();
// The last rows the server confirmed, by id. AG Grid changes its own copy while editing,
// so a refused edit is undone from here.
const saved = new Map();

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

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? "" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Only active order rows can be edited; the pinned totals row and cancelled rows can't.
const canEdit = (p) => !p.node.rowPinned && p.data.orderStatus === "active";
const itemName = (id) => menuItems.find((item) => item.id === id)?.name ?? "—";
const ordersText = (n) => `${plural(n, "order")} ready`;
const needsCheck = (data) => data?.unclear && data.orderStatus === "active";

// "Kak Ros" -> "KR", "Lina" -> "L". Only letters and digits, so emoji in a name can't break it.
function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

// The buyer cell: an initials avatar, the name and the buyer's subtotal, on the buyer's FIRST row only.
// The rows under it stay empty here, so one buyer's items read as one block (our own grouping:
// AG Grid's row grouping is Enterprise).
function buyerCell(p) {
  if (p.node.rowPinned) return p.value;
  const info = groupOf.get(p.data.id);
  if (!info?.first) return "";
  const { group } = info;
  const sub = group.cancelled ? "Cancelled"
    : group.total == null ? "Needs a check"
    : `${plural(group.items, "item")}, ${formatMoney(group.total)}`;
  const cell = el("span", "buyer");
  const text = el("span", "");
  text.append(el("span", "buyer-name", p.value || "No name"), el("span", "buyer-sub", sub));
  cell.append(el("span", "avatar", initials(p.value)), text);
  return cell;
}

// One icon per status, so the badge reads at a glance (the words carry the meaning, not the icon).
const STATUS_ICONS = {
  Draft: "PencilLine", Sent: "Send", "Part paid": "Hourglass", Paid: "CircleCheck",
  "Paid (cash/bank)": "Banknote", "Cancelled/Refunded": "CircleX", Cancelled: "CircleX",
};

// Status tag: a borderless pill with a soft tint and matching darker text. A cancelled order shows "Cancelled".
function statusBadge(p) {
  if (p.node.rowPinned) return "";
  const label = p.data.orderStatus === "cancelled" ? "Cancelled" : p.value;
  const badge = el("span", `badge badge-${String(label).toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`);
  badge.append(icon(STATUS_ICONS[label] ?? "Circle"), label);
  return badge;
}

// The words for an unclear row: "Check: <reason>", or "" when the row is fine.
const checkText = (data) => (needsCheck(data) ? `Check: ${data.reason}` : "");

// Phones and iPads have no room for a Check column, so the item cell carries the words under the item name:
// an amber row with no words only says "something's wrong", not what.
function itemWithCheck(p) {
  const words = p.node.rowPinned ? "" : checkText(p.data);
  if (!words) return p.valueFormatted;
  const cell = el("span", "");
  cell.append(p.valueFormatted, el("span", "check-text check-under", words));
  return cell;
}

// The columns. Phones get only Buyer, Item, Total, Status. The Check column is laptop-only (iPad and
// phone show the words under the item name) and only shows while some row needs checking.
function columns(size, anyCheck) {
  const isPhone = size === "phone";
  const narrow = (laptopWidth, ipadWidth, phoneWidth) => ({ laptop: laptopWidth, ipad: ipadWidth, phone: phoneWidth })[size];
  return [
    {
      field: "buyer", headerName: "Buyer", cellDataType: "text", flex: 2, minWidth: narrow(180, 190, 80),
      wrapText: true, autoHeight: true, cellRenderer: buyerCell,
    },
    {
      field: "itemId", headerName: "Item", cellDataType: "text", flex: 2, minWidth: narrow(140, 120, 96),
      wrapText: true, autoHeight: true, editable: canEdit,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: () => ({ values: menuItems.map((item) => item.id) }),
      // The select editor shows its options through this formatter too, so the seller sees names.
      valueFormatter: (p) => (p.node?.rowPinned ? ordersText(totals.orders) : itemName(p.value)),
      cellRenderer: size === "laptop" ? undefined : itemWithCheck,
    },
    {
      field: "qty", headerName: "Qty", cellDataType: "number", type: "rightAligned", minWidth: 52, maxWidth: 80, hide: isPhone,
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
      field: "lineTotal", headerName: "Total", cellDataType: "text", type: "rightAligned", minWidth: narrow(124, 124, 90),
      cellClass: ["money", "ag-right-aligned-cell"], valueFormatter: (p) => (p.value == null ? "—" : formatMoney(p.value)),
    },
    { field: "invoiceStatus", headerName: "Status", cellDataType: "text", minWidth: narrow(144, 144, 92), cellRenderer: statusBadge },
    {
      colId: "check", headerName: "Check", cellDataType: "text", flex: 2, minWidth: 140, wrapText: true, autoHeight: true,
      hide: size !== "laptop" || !anyCheck, valueGetter: (p) => checkText(p.data), cellClass: "check-text",
    },
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
    headerFontSize: 13,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    fontSize: isPhone ? 14 : 15,
    rowHoverColor: "#FAF8F5", // light warm tint, not blue: blue means clickable
    selectedRowBackgroundColor: "#F5F1EB",
    pinnedRowBackgroundColor: "#FAF8F5",
    rowHeight: 72, // roomy, and well over the 44 px tap minimum
    headerHeight: 48,
    wrapperBorder: false, // no outer border: the white card is the frame
    wrapperBorderRadius: 16,
    rowBorder: false, // our own hairline goes between buyers only (styles.css)
    columnBorder: false,
    headerColumnBorder: false,
    headerColumnResizeHandleColor: "transparent", // no vertical divider lines
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
  $("phone-total").replaceChildren(el("span", "", `Total: ${ordersText(totals.orders)}`), el("span", "money", formatMoney(totals.total)));
}

// The four summary cards. Figures come from the server (no money maths here); Expected is the hero.
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
  set("stat-check", String(summary.needsCheck), summary.needsCheck ? `${plural(summary.needsCheck, "order")} to fix below` : "All clear", summary.needsCheck ? "is-check" : "");
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

// Rows in buyer order (the server's groups), and which row starts each buyer.
function applyGroups(groups) {
  groupOf = new Map();
  for (const group of groups) {
    group.rowIds.forEach((id, i) => groupOf.set(id, { first: i === 0, group }));
  }
  return groups.flatMap((group) => group.rowIds.map((id) => rowsById.get(id)).filter(Boolean));
}

const anyCheck = () => [...rowsById.values()].some(needsCheck);

// Phone <-> wider, or the Check column appears/disappears: switch theme and columns.
// Wrapped rows (autoHeight) measure themselves again.
function fitToWidth() {
  if (!grid) return;
  grid.updateGridOptions({ theme: phone.matches ? themes.phone : themes.wide, columnDefs: columns(screenSize(), anyCheck()) });
  showTotals();
}

// One edited cell -> PUT /api/orders/:id. The server's reply (price, total, unclear flag, subtotals)
// replaces the row; if the server refuses the edit, the row goes back to how it was and the reason is shown.
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
    rowsById.set(id, reply.row);
    totals = reply.totals;
    summary = reply.summary;
    applyGroups(reply.groups);
    grid.applyTransaction({ update: [reply.row] });
    // The buyer's subtotal sits on its first row, which may be another row than the one edited.
    const first = reply.groups.find((group) => group.rowIds.includes(id))?.rowIds[0];
    const firstNode = first && grid.getRowNode(first);
    if (firstNode) grid.refreshCells({ rowNodes: [firstNode], columns: ["buyer"], force: true });
    fitToWidth(); // hides the Check column once nothing needs checking
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
    columnDefs: columns(screenSize(), false),
    animateRows: false, // rows jump straight to their new height; sliding added nothing here
    defaultColDef: { flex: 1, sortable: false, resizable: false, suppressMovable: true },
    domLayout: "autoHeight", // the page scrolls, not a box inside it
    rowData: [],
    getRowId: (p) => p.data.id,
    rowClassRules: {
      "row-unclear": (p) => !p.node.rowPinned && needsCheck(p.data),
      "row-cancelled": (p) => p.data?.orderStatus === "cancelled",
      "group-start": (p) => !p.node.rowPinned && groupOf.get(p.data?.id)?.first === true,
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
    source = state.source;
    rowsById = new Map(state.orders.map((row) => [row.id, row]));
    for (const row of state.orders) saved.set(row.id, structuredClone(row));
    showSetup(state);
    showSummary();
    showSource();
    foldChats(Boolean(source && state.orders.length));
    $("ai-calls-text").textContent = `AI calls left today: ${state.aiCallsLeft}`;
    showStep(state.orders);
    if (grid) {
      grid.setGridOption("rowData", applyGroups(state.groups));
      fitToWidth();
    }
  } catch (err) {
    showError(`Can't reach the server (${err.message}). Is npm start running?`);
  }
}

$("chat-date").value = todayLocal();
$("read-orders").addEventListener("click", () => {
  $("read-message").textContent = "Coming soon: reading orders is built in Step 4.";
});
$("chat-edit").addEventListener("click", () => {
  foldChats(false);
  $("chat").focus();
});
$("chat-hide").addEventListener("click", () => {
  foldChats(true);
  $("chat-edit").focus();
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
