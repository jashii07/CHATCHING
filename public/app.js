// The page: shows the server's state and an empty orders table (Step 1).
// Rows and editing come in Step 2, reading orders in Step 4 (PLAN.md Section 7).

// The planned order columns (PLAN.md Section 5, "Order row").
const COLUMNS = [
  { field: "buyer", headerName: "Buyer" },
  { field: "itemName", headerName: "Item", minWidth: 200 },
  { field: "qty", headerName: "Qty", minWidth: 80 },
  { field: "unitPrice", headerName: "Unit price (RM)" },
  { field: "lineTotal", headerName: "Total (RM)" },
  { field: "deliveryDate", headerName: "Delivery date" },
  { field: "fulfilment", headerName: "Pickup / delivery" },
  { field: "reason", headerName: "Check" },
  { field: "note", headerName: "AI note", minWidth: 220 },
  { field: "invoiceStatus", headerName: "Status" },
  { field: "payerLink", headerName: "Payer link" },
];

// The AG Grid features later steps rely on (all Community, none Enterprise).
const NEEDED_MODULES = {
  CsvExportModule: "CSV export",
  HighlightChangesModule: "cell flashing",
  QuickFilterModule: "quick filter",
};

const $ = (id) => document.getElementById(id);

// Today in the seller's own time zone (toISOString() would give the UTC date).
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function createOrdersGrid() {
  if (typeof agGrid === "undefined") {
    $("grid").textContent = "The table library (AG Grid) could not load. Check the internet connection and reload.";
    $("grid").classList.add("error");
    return null;
  }
  const grid = agGrid.createGrid($("grid"), {
    columnDefs: COLUMNS,
    defaultColDef: { flex: 1, minWidth: 120 },
    rowData: [],
    localeText: { noRowsToShow: "No orders yet. Paste chats and click Read orders." },
  });
  const missing = Object.keys(NEEDED_MODULES).filter((name) => !grid.isModuleRegistered(name));
  if (missing.length) console.error(`AG Grid is missing: ${missing.map((name) => NEEDED_MODULES[name]).join(", ")}`);
  else console.info(`AG Grid Community ready: ${Object.values(NEEDED_MODULES).join(", ")}.`);
  return grid;
}

async function showServerState() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!res.ok) throw new Error(state.error ?? `HTTP ${res.status}`);
    $("status").textContent = [
      `${state.menu.items.length} menu items`,
      `AI mode: ${state.aiMode}`,
      `PayPal keys: ${state.paypalConfigured ? "set" : "missing"}`,
      `Gemini key: ${state.geminiConfigured ? "set" : "missing"}`,
    ].join(" - ");
  } catch (err) {
    $("status").textContent = `Can't reach the server (${err.message}). Is npm start running?`;
    $("status").classList.add("error");
  }
}

$("chat-date").value = todayLocal();
$("read-orders").addEventListener("click", () => {
  $("read-message").textContent = "Coming soon: reading orders is built in Step 4.";
});
createOrdersGrid();
showServerState();
