# PLAN — ChatChing

**Live app: https://chatching.onrender.com/** (first load can take up to a minute while the free server wakes up).

Status: APPROVED 2026-10-25 (with changes). Standout features added 2026-10-25 (Sections 10-11). Build starts Mon 26 Oct, 7 PM MYT. **"Signature moments" added 2026-10-29** (Section 7: Steps 7, 10, 10b, 10c; Section 9: Sun 8 Nov polish; Section 13: new storyboard).

## 1. Problem

Small home sellers take orders as messy chat messages in English ("can i order 2 boxes of classic brownies, deliver on saturday?"). The demo seller is in Malaysia, so prices are in RM. They copy orders into Excel by hand, work out totals, then chase each buyer for payment one by one. It is slow and things get missed.

## 2. User

- **Main user:** a home seller (cakes, kuih, frozen food) with a small fixed menu and 10-50 chat orders a day. Not technical.
- **Judges:** open the link and act as that seller, each with their own table (a cookie, no login; changed 31 Oct), and pay as a buyer with a sandbox personal account. A one-time QR opens the same table on a phone (Open on my phone, 31 Oct).

## 3. Flow

1. **Paste:** the seller pastes a day of chat messages into a text box, and checks the **Chat date** field (the day the chats are from; default: today). The demo uses its own fixed chat date, 2026-10-28.
2. **Read (AI, 1 call):** Gemini turns all messages into the **final order per buyer**. It applies changes, add-ons and cancellations from later messages, resolves delivery dates, notes pickup vs delivery, and flags anything unclear with a reason. Each order comes with a one-line note explaining what it did. The AI never sets prices.
3. **Review:** rows appear in an AG Grid table, one row per item, so a buyer can have several rows. The code fills in the price from the menu and calculates the totals. The seller fixes unclear rows by editing cells. Clicking a row opens the buyer panel, which shows the buyer's own messages (Section 10, #1).
4. **Invoice (no AI):** one click creates and sends one PayPal sandbox invoice per buyer, grouping that buyer's rows, without emailing anyone. Cancelled and unclear rows are skipped. Each buyer gets a payer link and a ready-to-send message, each with a "Copy" button for pasting into the chat (#2).
5. **Track:** status moves Draft → Sent → Paid.
   - The page asks PayPal for the latest status (polling) when you click "Refresh status", and automatically every 20 s while the page is open.
   - The seller can also record a cash or bank-transfer payment in PayPal, and show a pickup QR code (#3).
6. **Remind (AI, 1 call):** for all unpaid buyers, Gemini drafts friendly reminders in one call, using the same design as #2. Each has a "Copy" button. If there is no AI, a template is used instead.

**Golden rule:** a payment never waits on the AI. Steps 4-5 make no AI calls. Messages are added after the invoices exist.

## 4. Architecture A: one simple server

One Node 24 server (Express) serves the page and the API. The page is plain HTML + JavaScript, with AG Grid Community **36.2.0** loaded from jsDelivr. There is no build step. All keys stay on the server.

```
server.js                 Express app: routes + serves public/
src/paypal.js             token (cached in memory) + create/send/get invoice, record payment, QR code
src/ai.js                 Gemini: one batched call, timeout, retry, backup model, cache, mock mode
src/messages.js           placeholders {items} {total} {date} {link}, checks, English templates
src/fallback.js           non-AI: alias-based parser
src/orders.js             pure logic: prices from menu, totals, group rows by buyer, status mapping
src/dates.js              message timestamps + day words ("tomorrow", "Saturday", "Friday") -> dates
src/store.js              one visitor's orders + old batches, saved to data/runtime/visitors/<id>.json
src/visitors.js           (31 Oct) the visitor id and cookie, the file path, cleanup (14 days, 500 files)
src/pickup.js             (31 Oct) pickup check + Collected: this visitor's table, live status through src/status.js
src/pairing.js            (31 Oct) Open on my phone: one-time codes (hashes only, in memory) and the pairing QR
src/security.js           (2 Nov) security headers on every reply; refuses changes from other websites
public/index.html         the page
public/app.js             AG Grid table, buyer panel, buttons, polling
public/styles.css
public/invoice-qr.js      (31 Oct) reads an invoice or a pairing link from a QR or the typing box; used by the page AND the server
public/pair.html, pair.js (31 Oct) the small page a phone lands on; it POSTs the code from the address and goes to /
public/vendor/            (31 Oct) jsQR 1.4.0, self-hosted, with its Apache-2.0 licence
public/csv-safe.js        (2 Nov) keeps a buyer's name from reaching Excel as a formula; used by the page AND the tests
data/menu.json            fixed menu (item -> price, aliases)
data/demo-chats.txt       fictional English chats
data/expected-orders.json correct answers for demo-chats.txt
data/holdout/             (by 1 Nov; git-ignored) REAL chats from a seller + their expected answers (written by Jasper);
                          never used while tuning the prompt; committed only once anonymised AND agreed (Section 10, #5)
data/ai-cache/            saved AI results (key = hash of input); includes the preloaded demo
test/                     node:test tests (built into Node, no package)
scripts/                  smoke tests + accuracy.mjs
```

Only one new package is planned: **express**. (31 Oct: also **qrcode-generator 2.0.4**, MIT, no dependencies of its own, for the pairing QR.)

### Routes

| Route | What it does | AI? |
|---|---|---|
| `GET /` | the page | No |
| `GET /api/state` | menu, orders, "AI calls left today", AI mode | No |
| `POST /api/parse` | chat text + chat date → order rows (replaces the current rows) | 1 call, or cache/fallback |
| `PUT /api/orders/:id` | save one edited row | No |
| `POST /api/invoices` | create + send one invoice per buyer that has no invoice yet (double-invoice guard, #3c) | **Never** |
| `POST /api/buyers/:id/send-anyway` | (1 Nov) clears "already has an invoice from an earlier batch today": a real second order. Doesn't send anything | **Never** |
| `POST /api/invoices/refresh` | ask PayPal for the status of every open invoice | No |
| `POST /api/invoices/:id/payment` | record a cash / bank-transfer payment in PayPal (#3a) | **Never** |
| `GET /api/invoices/:id/qr` | pickup QR code image from PayPal (#3b), with its file name (`pickup-Lina.png`) for Save QR | **Never** |
| `POST /api/messages` | ready-to-send message per invoiced buyer (#2) | 1 call, or template |
| `POST /api/reminders` | reminders for all unpaid buyers, same design as messages | 1 call, or template |
| `POST /api/reset` | Reset demo: empty this visitor's table so their demo starts over; sent invoices stay in the visitor's file; nothing in PayPal is deleted or cancelled (changed 28 Oct, Step 6) | **0 calls** |
| *(no route)* | (Step 10b, done 29 Oct) kitchen list: per date, how many of each item to make. Sent as `kitchen` in `/api/state` and every edit reply instead of its own route | **Never** |
| `POST /api/pickup/check` | (Step 10c, done 31 Oct) `{ invoiceId }` (id or number): look ONLY in this visitor's table, get the live status through the status code (cache + rate limit), reply with buyer, items, total and paid or not | **Never** |
| `POST /api/pickup/collected` | (Step 10c, done 31 Oct) `{ invoiceId, undo? }`: mark Collected, our own status, never sent to PayPal, only when paid; Undo allowed | **Never** |
| `POST /api/pair/new` | (31 Oct) a new one-time pairing link for this visitor, and its QR; rate limited | **Never** |
| `GET /pair` | (31 Oct) the phone's page; the code stays after the `#`, so it never reaches the server here | No |
| `POST /api/pair/open` | (31 Oct) `{ code }`: works once, for 10 minutes; gives the phone the laptop's visitor cookie; anything else gets the same friendly words; rate limited. (2 Nov) A browser with orders of its own gets `{ confirm }` and nothing changes until `{ code, replace: true }` | **Never** |

### AG Grid showcase (Community features only, no Enterprise)

*Design round 3 (27 Oct): editing moved from the cell editors (select + date) into the buyer drawer's simple form fields (Jasper's choice), so those two editors left this list; pagination joined it.*

| Feature | Used for |
|---|---|
| Pagination (`pagination`, 6 rows per page, our own arrows via `paginationGoToNextPage`) | one buyer per row, 6 buyers per page (design round 3) |
| Auto row height + custom cell renderers | buyer avatar, item chips with food icons, phone cards |
| Custom cell renderer: status badge | Draft / Sent / Paid / Paid (cash) / Cancelled in colours |
| `rowClassRules` | highlight unclear rows (and grey out cancelled ones) |
| Custom cell renderer: Copy-link button | copy the payer link for the chat |
| Pinned bottom row | totals: number of orders and RM total |
| Quick filter search box (`quickFilterText`) | find a buyer or item fast (**built early, 27 Oct**) |
| External filter (`isExternalFilterPresent` / `doesExternalFilterPass`) | the Needs check card shows only the buyers that need a check (27 Oct) |
| CSV export (`getDataAsCsv` + our own UTF-8 byte-order mark) | "Export CSV" button: every buyer, opens in Excel (#4, **built early, 27 Oct**) |
| Cell flashing (`flashCells`) | the status cell flashes green when it turns Paid (#4) |
| Row click event (`onRowClicked`, Enter key via `onCellKeyDown`) | opens the buyer drawer: edit items, qty and dates (round 3); the buyer panel (#1) joins it in Step 7 |

**Not used (Enterprise):** row grouping, Excel `.xlsx` export, the Side Bar and the clipboard module.
- Rows are grouped per buyer in our own code.
- The buyer panel is our own HTML.
- Copy buttons use the browser's clipboard.
- In step 1, check that each feature works with the Community bundle from the CDN.

## 5. Data shapes

**Menu** (`data/menu.json`), the only source of prices:
```json
{
  "currency": "MYR",
  "items": [
    { "id": "classic_brownies", "name": "Classic brownies (box of 6)", "price": "18.00",
      "aliases": ["classic", "brownies classic", "classic brownies", "classic brownie"] },
    { "id": "cheese_brownies", "name": "Cheese brownies (box of 6)", "price": "22.00",
      "aliases": ["cheese brownie", "cheese brownies", "brownies cheese"] }
  ],
  "ambiguous": [
    { "words": ["brownies", "brownie", "brwnies"], "reason": "Which brownies: classic or cheese?" }
  ]
}
```
(Full fictional menu in `data/menu.json`.) A plain "brownies" or "brwnies" with no type must **not** map to one item. It becomes an unclear row with the reason "Which brownies: classic or cheese?".

**Currency: one setting.** `"currency"` in `data/menu.json` decides every amount on screen, in messages and in PayPal invoices. Money is shown with `Intl.NumberFormat` (MYR → "RM 54.00", USD → "$54.00"). No code hard-codes "RM", and a test checks this.
- For the README: "Works with any PayPal currency; the demo uses MYR because the real user is a Malaysian home seller."
- Exception: PayPal bills JPY, HUF and TWD without decimals, but our prices use cents ("18.00"). The server refuses to start with these currencies and shows a clear message.
- **README warning (trap):** changing `"currency"` does NOT convert any prices: there is no exchange rate, so RM 54.00 just becomes $54.00. A seller who switches currency must also update every `"price"` in `data/menu.json`.

**What the AI returns**: the **final** order per buyer (forced JSON format, no prices):
```json
{ "orders": [
  { "buyer": "Lina", "status": "active", "sourceMsgs": [1, 4],
    "items": [ { "itemId": "classic_brownies", "qty": 3 } ],
    "deliveryDate": "2026-10-31", "fulfilment": "delivery",
    "unclear": false, "reason": "", "note": "Changed from 2 to 3 boxes in message 4." },
  { "buyer": "Priya", "status": "active", "sourceMsgs": [7],
    "items": [ { "itemId": null, "qty": null } ],
    "deliveryDate": null, "fulfilment": null,
    "unclear": true, "reason": "\"Same order as last week\": items not stated.",
    "note": "Asked for last week's order; no items given." }
] }
```
- `status`: `"active"` or `"cancelled"`. The AI applies changes ("make it 3 boxes"), add-ons ("add 1 jar cookies") and cancellations ("actually cancel pls") from later messages.
- `sourceMsgs`: the message numbers used, so the seller can see where each order came from.
- `itemId` can be `null` when unclear.
- `fulfilment`: `"delivery"`, `"pickup"` or `null`. It decides whether the pickup QR button shows (#3b).
- `note`: one line, max 120 characters, saying what the AI did. It is shown as plain text only (#1).
- Questions ("do you still have bahulu?") and payment requests ("pls send me the payment link") are **not** orders. They appear only in `sourceMsgs` if they belong to a real order.
- `mentionedPrices` (optional, **added 29 Oct, Step 7**): prices the buyer wrote, e.g. `[{ "text": "RM15", "itemId": "classic_brownies", "msg": 4 }]`. `text` is the price as written, `itemId` the menu id it refers to (or `null`), `msg` the message number. **The AI only reports; it never decides.** Our code reads the number from `text` and compares it with `menu.json`. A mismatch makes the row amber: "Check: buyer mentioned RM 15.00, menu says RM 18.00." **The invoice price always comes from the menu.**
  - Details for Step 7 (Claude's proposal, to confirm in that session): a mention matches if it equals the unit price, the line total ("2 boxes for RM36") or, when `itemId` is null, the buyer's total. The amber row is unclear like the Chat-date warning (check first, charge second), so it blocks invoicing until the seller clears it.

**Add-ons and seller messages (added 1 Nov):**
- A menu item may have `"addon": true`. The AI lists a paid add-on as its own item with its quantity (iced latte with oat milk = 1 x Iced Latte + 1 x Oat Milk). The price comes from the menu, as always.
- Free requests (sugar level, less/no ice, remove mayo) go in `note`, never an item.
- `notOnMenu` (optional, text only): what the buyer asked for that the menu doesn't have. The AI only reports the name; our code writes "buyer asked for <x>, not on the menu." and makes the order unclear. A whole item not on the menu also gets an item with `itemId: null`.
- `sellerName` in `data/menu.json`: the seller's messages are context only. They never create a buyer or an order, and a price the seller writes is never compared (`src/seller.js`, `checkOrders`).

Our code checks every order:
- `itemId` must be `null` or exist in the menu.
- `qty` must be a whole number from 1 to 99.
- Every message number must exist.
- The date must be valid, and on or up to 14 days after its message.

Anything that fails a check becomes an unclear row. It is never dropped silently.

**Order row** (what the table shows: one row per item; a buyer can have several):
```json
{ "id": "r1", "buyer": "Lina", "buyerEmail": null, "orderStatus": "active",
  "itemId": "classic_brownies", "itemName": "Classic brownies (box of 6)", "qty": 3,
  "unitPrice": "18.00", "lineTotal": "54.00",
  "deliveryDate": "2026-10-31", "fulfilment": "delivery",
  "unclear": false, "reason": "", "note": "Changed from 2 to 3 boxes in message 4.", "sourceMsgs": [1, 4],
  "invoiceId": null, "invoiceNumber": null, "payerLink": null, "invoiceStatus": "Draft" }
```
- Money is calculated in cents (whole numbers; "sen" for MYR) to avoid rounding errors, stored as "54.00", and shown in the menu's currency ("RM 54.00").
- Invoices group rows per buyer. A buyer is invoiced only when all their active rows are clear.

**Accuracy check:** `data/expected-orders.json` holds the correct answers for the demo chats: **since Step 7 (29 Oct): 18 messages, 7 clear orders worth RM 366.00, 2 that need a check (Priya: which brownies; Jun Wei: a wrong price), 1 cancelled and 2 non-orders** (before Step 7: 15 messages, 7 orders, RM 387.00), plus the demo's fixed `chatDate` (2026-10-28). Its orders use the same field names as the AI output above, so `scripts/accuracy.mjs` compares the parser's output against it directly, with no name translation (see Section 7).

**Invoice status**: PayPal's status → what the app shows:

| PayPal | App |
|---|---|
| (no invoice yet), `DRAFT` | Draft |
| `SENT`, `UNPAID`, `SCHEDULED`, `PAYMENT_PENDING` | Sent |
| `PARTIALLY_PAID` | Part paid |
| `PAID` | Paid |
| `MARKED_AS_PAID` | Paid (cash/bank) |
| `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `MARKED_AS_REFUNDED` | Cancelled/Refunded |

Proven in the smoke tests on 2026-10-25:
- MYR works.
- After sending, the status is `UNPAID`.
- The payer link is the `href` with `rel: "payer-view"` in the send response.
- After paying by hand with the sandbox personal account, `GET` shows `PAID` with a payment of 55.00 MYR, method `PAYPAL`, so polling works.
- Recording a cash payment gives `MARKED_AS_PAID` with method `CASH`.

## 6. AI design

- **One batched call** per action. All messages go in one prompt, and the final order per buyer comes out, each with a note. ~~Messages and reminders are also one call each (Section 10, #2).~~ **Changed 30 Oct (Step 10):** messages, reminders and questions are code templates, no AI (Section 10, #2). The JSON shape is forced with Gemini's response schema. The prompt includes the menu ids and aliases, and the "plain brownies = unclear" rule.
- **Dates come from each message's own timestamp plus the Chat date, never from today's date.**
  - Timestamps like `[28/10 9:02 AM]` have no year. The page sends a **Chat date** with the paste (default: today; the demo carries its own fixed chat date, 2026-10-28).
  - **Year rule ("nearest date"):** each message gets the year (the chat date's year, or one before or after) that puts it **nearest** to the chat date. On a tie, the earlier year wins. So `[31/12]` with chat date 2 Jan 2027 is 31 Dec 2026, and `[28/10]` with chat date 28 Oct 2026 is 28 Oct 2026.
  - **Warning, never a silent move:** if the result is **after** the chat date, or **more than 60 days** away from it, the row gets a visible warning "Check the Chat date". The seller decides; the code never quietly moves a message to another year.
  - **Impossible dates** (for example `[29/2]` when the nearest year has no 29 Feb, or `[31/4]`) make the row unclear. No guessing.
  - The code turns each timestamp into a full date with its weekday ("Wed 28 Oct 2026") before sending it to the AI. A day name means the next such day after the message date, so "tomorrow" in a message from Wed 28 Oct is Thu 29 Oct, and "Saturday" is Sat 31 Oct.
  - `src/dates.js` takes the chat date as an input and never reads the computer's clock. It does the same conversion without AI for the fallback parser. Our code then checks the AI's dates (Section 5).
  - The chat date is part of the AI cache key, so the same chats with a different chat date are not answered from the cache.
  - **Test cases** (`test/dates.test.js`):

    | Chat date | Message | Expected |
    |---|---|---|
    | 2026-10-28 | `[28/10]` "Saturday" | 2026-10-31, the same whether the test runs on 26 Oct 2026 or in December (test runs with the clock faked to both days) |
    | 2026-10-28 | `[28/10]` "tomorrow" / "Friday" / "Sunday" | 2026-10-29 / 2026-10-30 / 2026-11-01 |
    | 2027-01-02 | `[31/12]` | message date 2026-12-31, no warning (2 days before) |
    | 2027-01-02 | `[2/1]` | message date 2027-01-02, no warning |
    | 2026-10-28 | `[29/10]` (1 day after the chat date) | message date 2026-10-29 **+ warning "Check the Chat date"** |
    | 2026-10-28 | `[15/7]` (105 days before) | message date 2026-07-15 **+ warning "Check the Chat date"** |
    | 2027-03-01 | `[29/2]` (no 29 Feb in 2027) | impossible date: the row becomes unclear, no guessing |
    | 2028-03-01 | `[29/2]` (2028 is a leap year) | message date 2028-02-29, no warning |
- **Mock mode** (`AI_MODE=mock`, `src/ai.js` `mockParse()`): returns saved results from `data/ai-cache/`, using 0 real calls. **Since Step 3b the demo rows come from Gemini's real reply** (`demo-parse.json`; replaced in Step 7 by the reply for the messier chats, also a perfect score); `expected-orders.json` stays the answer key it is scored against. This is the default during development. The demo's parse result is Gemini's real reply from the AI reality check (Step 3b), saved unchanged, so mock mode behaves like the real AI.
- **Cache:** every real AI result is saved to disk with the hash of its input as the key. The same input never costs a second call.
- **Preloaded demo:** the demo chats and their saved AI results (parse, messages, reminders) ship in the repo. "Reset demo" uses them, with 0 calls.
- **Timeout + retry + backup model:** *(Step 9, 30 Oct: replaced by ONE 60 s budget per parse, see Section 7 Step 9.)* **45 s for the parse call** (changed from 30 s after Step 3b measured 17.6 s for the 15 demo messages, 61% of it hidden thinking; a 50-message paste will take longer), 30 s for the shorter message/reminder calls. On 503 or 429 (they come back fast: the 503 in Step 3b took 3.8 s), retry once after a short wait, then try the backup model (`gemini-3.6-flash` first, then `gemini-3.8-flash`; each has its own 20/day). After a **timeout**, don't retry the same model (that could make the seller wait 90+ s): go to the backup model or the non-AI fallback. The page says "Reading 15 messages... this can take up to a minute" while it waits. Re-measure in Step 9 with a longer paste.
- **Non-AI fallback:** if the AI fails or today's quota is used up, a simple parser takes over. **Built 30 Oct (Step 10, `src/fallback-parse.js`):** never automatic; the notice gets a **Read without AI** button, and the rows get an amber banner + "AI mode: read without AI" in the footer. It also makes a change, a cancellation or "same as" unclear (instead of only "several messages"). Demo: 1 clear, 9 unclear, 0 wrong invoiceable orders.
  - It matches menu aliases and numbers in each message, and `dates.js` handles the dates.
  - Ambiguous words like "brownies" become unclear rows.
  - It doesn't try to apply changes or cancellations. It flags a buyer with several messages as "check later messages".
  - Messages and reminders fall back to the English templates.
- **Daily call counter:** the server counts real calls per model per day and shows "AI calls left today: X/20" on the page. When it hits 0 the server stops calling and uses the fallback. Assumption: Google's day resets at midnight Pacific time (to verify). The count is our own estimate and may differ from Google's.
- **Input limits:** at most 120 messages / 15,000 characters per paste (raised 1 Nov from 50 / 10,000: real chats include the seller's replies, and Set B's 93 messages read in 24.1 s). The page checks the character limit too.
- **Accuracy:** measured with `scripts/accuracy.mjs` against known answers, and once against holdout chats the prompt was never tuned on (Section 10, #5).
- **Privacy:** the Gemini free tier may use inputs to improve Google's products, and "human reviewers may read" them. So only fictional or anonymised chats are sent (Section 10, #5).

## 7. Build order (mock AI first)

Order in time (dates in Section 9): 1 → 3 → 2 → 3b → 4 → 5 → … Step 3 (pure logic) runs before Step 2, so the grid is built after the UI spec (Section 12) and can use the price logic. Every UI step follows Section 12.

1. ✅ (done Sun 25 Oct) Express skeleton, menu, demo chats, empty page. Load AG Grid 36.2.0 from the CDN, and check that CSV export, cell flashing and the quick filter are in the bundle.
2. ✅ (done Tue 27 Oct) AG Grid table showing orders; edit cells → `PUT /api/orders/:id`. Select editor (menu items) + date editor.
3. ✅ (done Mon 26 Oct) `money.js` + `orders.js` + `dates.js` pure logic (prices, totals, grouping per buyer, status mapping, day words) + tests.

**3b. ✅ (done Tue 27 Oct) AI reality check (spike).** Result: perfect score (9/9 buyers, 8/8 items, qty, dates, unclear flags and fulfilment, 9/9 cancellations), 17.6 s, 2 of 3 calls used (the 1st got a 503). Details in DECISIONS.md. Why: the AI is the least-proven part. We proved PayPal on day 1; now we prove the AI before building on it.
- `scripts/spike-parse.mjs` makes ONE real `gemini-3.6-flash` call on `data/demo-chats.txt`, with the menu (ids, aliases, the "plain brownies = unclear" rule), chat date 2026-10-28 (each message gets its full date from `dates.js`) and the planned JSON schema (Section 5).
- It prints how long the call took, and compares the reply with `data/expected-orders.json`: buyers, items, qty, dates, unclear and cancelled (for example "items 8/9").
- It uses a long timeout (90 s) to measure the real time, so we can check the app's planned 30 s timeout (Section 6) against it.
- **Max 3 real calls that day** (of the 20/day free quota): the script counts its own calls in `tmp/` and refuses a 4th. Run it with `node --env-file=.env` (it never opens .env). The demo chats are fictional, so they're safe for the free tier.
- **The real reply is saved unchanged** as `data/ai-cache/demo-parse.json`. Step 4's mock mode returns it, so the mock data matches what Gemini really returns, mistakes included.
- The prompt, schema and comparison code are reused in Step 7 (the real call inside the app) and Step 8 (`accuracy.mjs`).

4. ✅ (done early, Wed 28 Oct) Parse with **mock AI** (results already include `note` and `fulfilment`) + validation + unclear rows (`rowClassRules` highlight). `POST /api/parse`, `src/paste.js` (limits), `src/validate.js` (checks), phone timestamp formats, `npm run ui-parse` (since Step 5: `npm run ui-flow`).
5. ✅ (done early, Wed 28 Oct) PayPal invoices: create + send per buyer, payer link + Copy-link renderer, **double-invoice guard (#3c)**. `src/paypal.js`, `src/invoices.js`, `POST /api/invoices`, `POST /api/new-batch`, `npm run ui-flow`; real sandbox invoice `INV2-BKCU-NGE3-RZG3-U35Y` (UNPAID, 54.00 MYR).
   - **Progress (added 28 Oct, Jasper):** sending goes one buyer at a time, and a thin bar + "Sending invoice 3 of 7..." moves only after each invoice is really done (no timer). A failed buyer shows the amber "Error: ..." on their row, the others continue, and the run ends with "6 of 7 sent, 1 needs a retry". The server guards are unchanged. With reduced motion the words still count but the bar doesn't animate.
   - **Button (added 28 Oct, Jasper):** when every clear order already has an invoice, the Send button reads "All invoices sent" (disabled), not just grey.
   - Missing PayPal keys → the clear message "PayPal is not configured", sent on purpose (the error handler hides every 5xx message), plus a test.
   - **Batches (added 28 Oct, Jasper):** once any invoice has been sent for the current orders, "Read orders" is blocked with the message "Invoices already sent for these orders. Start a new batch to read again." A **"New batch"** button saves the old batch and starts an empty one, so invoice links are never wiped and never sent twice. Needs tests: reading is refused after an invoice is sent (server, not only the page); New batch keeps the old batch's rows and invoice links; the new batch starts empty and can be read; no buyer of the old batch is invoiced again.
6. ✅ (done early, Wed 28 Oct; the first Render deploy stays on Sat 31 Oct) Status polling + Refresh button + status badges + Reset demo. **Paid flash (#4)**, **record cash / bank (#3a)**. `src/status.js`, `src/payments.js`, `POST /api/invoices/refresh`, `POST /api/invoices/:id/payment`, `POST /api/reset`; real sandbox: `INV2-BKCU-NGE3-RZG3-U35Y` MARKED_AS_PAID (CASH 54.00 MYR). (CSV export, the pinned totals row and the search box were built early, on 27 Oct.)
7. ✅ (done early, Thu 29 Oct) Real Gemini call (one batched call, final order per buyer, JSON schema), cache. **Buyer panel with note + highlighted source messages (#1)**, **pickup QR in the panel (#3b)**. Real mode: saved demo reply first, then `data/runtime/ai-cache/` (git-ignored), then the main model, then the backup on 503/429/timeout (`src/ai.js`, `src/gemini.js`). Gemini's reply on the new chats: **perfect score in 21 s, 2 calls** (the 1st a 503). The panel marks items, quantities, days, pickup/delivery, changes and prices in the buyer's own messages (`src/panel.js`); the QR is shown for every sent invoice. 282 tests.
   - **a. Price mismatch (added 29 Oct):** the schema gets the optional `mentionedPrices` list (Section 5). The AI only reports what the buyer wrote; the code compares it with `menu.json`; a mismatch makes the row amber ("Check: buyer mentioned RM 15.00, menu says RM 18.00."). The invoice price always comes from the menu. Tests: match, mismatch, unreadable text, unknown item id.
   - **b. Messier demo chats for the video (added 29 Oct):** add a few realistic twists to `data/demo-chats.txt`: a change of quantity, "same as Lina", a cancelled add-on, and one price mention that is wrong. Update `data/expected-orders.json` to match (and the "7 orders / RM 387.00" numbers in Sections 5 and 9), then save Gemini's **real** reply as the new demo cache (`data/ai-cache/demo-parse.json`), scored with the Step 3b scorer. Fictional chats only (free-tier privacy).
8. ✅ (done early, Thu 29 Oct; `src/accuracy.js` + `scripts/accuracy.mjs`, 310 tests) **`scripts/accuracy.mjs`**: compares an AI reply with an expected-orders file using the same scorer as Step 3b (`src/score-parse.js`), and prints a score for each of buyers, cancellations, items, quantities, dates, unclear flags, pickup/delivery and prices, plus every difference in plain English ("Jun Wei: expected 2 x Cheese brownies, AI said 1.").
   - `--cached` (default): scores the saved reply, 0 calls. `npm run check` runs it and fails if the demo reply stops scoring perfectly. Saved demo reply: **74/74**.
   - `--live`: ONE parse through the app's own AI code (main model, backup if it fails; at most 2 calls). Run with `node --env-file-if-exists=.env`. Reports go to `tmp/`; `docs/accuracy.md` is written by hand from them (changed 1 Nov).
   - Any chats: `--chats <file> --expected <file> --date <YYYY-MM-DD>` (default: the demo). This replaces the planned `--real` / `--holdout` flags.
   - **Live demo run on 29 Oct: no score.** Both models answered 503 "high demand" (main after 43 s, backup after 4.3 s); 2 of 2 calls used; not retried. Run `--live` again on another day (2 calls max).
   - No prompt tuning: the saved reply is already perfect on the demo, and tuning on the chats we score only polishes the demo number.
   - **Added 1 Nov:** `--menu <file>` (a test set's own menu), `--one-call <seconds>` (one call to the main model, no retry, no backup, for measuring long chats). It now scores what the app would show (after `checkOrders`). Every live report goes to `tmp/` or `--out`; `docs/accuracy.md` is written by hand from those reports.
   - **Two test sets (1 Nov), `data/holdout/`:** Set A "cafe-usd" **73/74** in 28.2 s and Set B "daily-grind" **74/74** in 24.1 s, both on gemini-3.6-flash, details in `docs/accuracy.md`. Set A's first try got a 503 after 38.9 s. No prompt tuning on these sets. `--backup` sends the one call to the backup model (not needed). Command: `node --env-file-if-exists=.env scripts/accuracy.mjs --live --one-call 180 --chats data/holdout/<set>/chats.txt --expected data/holdout/<set>/expected.json --menu data/holdout/<set>/menu.json --date <2026-10-30 or 2026-10-31> --out tmp/accuracy-<set>.md`.
9. ✅ (done early, Fri 30 Oct; `src/usage.js`, `GET /api/parse/progress`, `npm run ui-ai`, 323 tests) Timeout, retry, backup model, daily counter, "AI calls left".
   - **One 90 s budget per parse (raised 1 Nov; it was 60 s, main 35 s):** the main model gets up to 60 s, the backup the rest (at least 30 s). One retry on 503/429 after ~2 s, only if 20 s (a real read) still fits and a call is left for the backup. Never more than 3 calls. Replaces the old 45 s per-call timeout below.
   - **Loading words from the server's real stage** (the page asks once a second): "Reading the chats...", then "The AI is busy, trying the backup...". Button disabled until the end.
   - **All failed:** "The AI is busy right now. Please try again in a minute, or click Load demo to see how it works." (200, rows unchanged, no red error).
   - **Daily counter:** every call attempt counted (failed ones too), per model (20 each, so the top bar starts at 40), saved in `data/runtime/ai-usage.json`, new count at midnight Pacific. At 0: no call, "Today's free AI reads are used up. Try again after 3 PM Malaysia time, or click Load demo." The hour is worked out: **4 PM from 1 Nov** (US winter time). Load demo and cached chats still work at 0.
   - **Live demo run on 30 Oct: no score again.** Main 503 after 24 s, backup no answer within its 36 s; notice at 60 s; 2 calls. Not retried.
10. ✅ (done early, Fri 30 Oct; `src/fallback-parse.js`, `src/messages.js`; 345 tests; `ui-ai`, `ui-flow`, `ui-check` extended) **Ready-to-send messages + reminders (#2)**: ~~one batched call each, placeholders, checks,~~ code templates only (decided 30 Oct: AI calls are scarce), Copy. Plus the **non-AI fallback "Read without AI"** (moved up from Step 12: Gemini was busy on 29 and 30 Oct) and the chip fix (chips wrap inside their column). **Follow-up the same day:** Add / Remove item in the drawer (locked once the invoice is sent, server-checked) and the table always fits its panel (columns chosen by the table's own width); 352 tests.
   - **Ask the buyer (added 29 Oct):** every unclear row gets a **"Copy question"** button. The code builds the question from the menu and the reason it is unclear, e.g. "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?" The AI may only write wording with placeholders (same design and checks as #2: no money, no links); **the code fills in names, items and prices**. Template when there is no AI. ~~Open for Step 10: whether the AI wording rides in one batched call for all unclear rows or the template is enough.~~ Decided 30 Oct: the template is enough (code only, no AI).
10b. ✅ (done early, Thu 29 Oct; `src/kitchen.js`, the list rides along in `/api/state` and every edit reply as `kitchen`, no separate route; 297 tests) **Kitchen list (new, 29 Oct; pure code, no AI):** per date, how many of each item to make, from **active clear orders only**. Cancelled orders are left out; unclear orders are not counted but shown separately as "+1 order still to check". A **Copy** button copies the list as plain text. Tests: cancelled excluded, unclear shown apart, several dates, an empty day.
10c. ✅ (done Sat 31 Oct; `src/pickup.js`, `public/invoice-qr.js`, `public/vendor/`, `npm run ui-pickup`, 459 tests, version 1.2.0) **Pickup scan (new, 29 Oct; the feature we drop first if time is tight):** on a phone, the seller scans the buyer's PayPal invoice QR with the camera. Built as below except: jsQR is self-hosted (no CDN, so no integrity hash), and no Content-Security-Policy was added (decided 31 Oct, see DECISIONS.md; added 2 Nov in `src/security.js`).
   - The app finds the invoice id in the QR, checks it is in our store, and asks PayPal for the **live** status.
   - Paid: a big green "Paid: Lina, 3 x Classic brownies". Not paid: an amber "Not paid yet: RM 54.00".
   - Then a **"Collected"** button: our own status, **never sent to PayPal**.
   - **Fallback:** type the invoice number when the camera isn't available (or permission is refused).
   - Any QR library is pinned with an integrity hash (like AG Grid and Lucide). Add a Content-Security-Policy (the app has none yet) that allows it; **never `'unsafe-eval'`**.
   - The camera needs HTTPS, so test it on Render (localhost also counts as secure for a first check).
   - **What PayPal's QR holds (verified 29 Oct, Step 7):** decoded from two real sandbox QR codes (25 Oct and 29 Oct) with `scripts/decode-qr.mjs` (jsQR 1.4.0): `https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1`, i.e. the invoice's payer page with the **full invoice id (with dashes)** and `?qr=1`. QR version 5, 86 characters. `invoiceIdIn()` in `src/qr.js` already reads the id from it (tested). So the scan needs no PayPal call to find the invoice; it then checks our store and asks PayPal for the live status. Expect a live (non-sandbox) QR to say `www.paypal.com` instead (not tested).
   - ~~Still assumed after 10c: how the buyer has the QR on pickup day; a table belongs to one browser.~~ Both closed by Step 10d.
10d. ✅ (done Sat 31 Oct; `src/pairing.js`, `public/pair.html`, `public/pair.js`, `npm run ui-pair`, version 1.3.0) **One table on two devices, and the buyer's QR.** Jasper's decisions, with his advisor; DECISIONS.md has the details.
   - **Open on my phone:** a button shows a QR with a one-time link (`/pair#<code>`, 128 random bits, 10 minutes, works once, stored only as a hash). The phone POSTs the code and gets the same visitor cookie. The phone's camera app opens it; Pickup scan and its typing box know it too.
   - **Save QR + the message:** the check showed a buyer had no way to get the QR. The drawer now saves PayPal's QR as `pickup-Lina.png`, and the Copy message of a pickup order ends "Show this QR when you pick up."
   - **Two devices stay in step:** Refresh status and coming back to the tab now show what the other device changed (Collected, sent invoices). Before, only a change from PayPal or a new batch redrew the table.
11. Deploy to Render; end-to-end test on the hosted URL.
   - **Part 1 ✅ (done early, Fri 30 Oct; 370 tests):** the app is ready for Render's free plan: `PORT`/`RENDER`, no `.env` needed, `GET /api/health` (ok + version only), `npm ci --omit=dev`, Node 24, clean start with no runtime files, Google's daily-limit 429 marks a model used up, a per-visitor rate limit (`src/rate-limit.js`), the summary figures always fit their cards (part 0). Click-by-click guide for Jasper: `docs/deploy-render.md`.
   - **Part 2 ✅ (done early, Fri 30 Oct):** live at **https://chatching.onrender.com/** (first load can take up to a minute while the free server wakes up). `npm run ui-live` runs the whole flow on the hosted URL at 1280 + 390 px with real sandbox invoices: Load demo → Read orders → Send invoices → record cash → Refresh → Kitchen list → Reset demo. Cold start measured once: 22.9 s after 17 idle minutes. A buyer really paying in the sandbox stays a manual check (it needs a buyer login).
   - **Part 3 ✅ (done Sat 31 Oct; 420 tests): per-visitor tables.** Every browser gets its own table (a cookie, no login): `src/visitors.js`, `data/runtime/visitors/<id>.json`, batch ids of 12 characters, cleanup at 14 days / 500 files. The AI counter and rate limits stay global. A tab left open through a server wipe recovers with plain words. `npm run ui-visitors` drives two browsers at once locally; `npm run ui-live` passed on the hosted app (version 1.1.0): 43 checks, 14 real sandbox invoices with 25-character numbers, 0 Gemini calls.
   - **Part 4 ✅ (done 2 Nov): review fix sessions A and B merged, version 1.6.0.** Security headers, refusing other sites' requests, local listening, pairing asks first; 653 tests. `npm run ui-live` passed on the hosted app, 94 checks, including the headers.
12. **User test with a real seller (#5)**; ~~non-AI fallback parser~~ (built early in Step 10, 30 Oct).
13. Edge-case tests, **holdout accuracy run (#5)**, README, video script, Devpost draft. **Progress 2 Nov:** README.md written for judges and the Devpost sections filled in `docs/devpost-draft.md`, checked in a clean clone; still to add: the judge logins (Sat 7 Nov) and the video link. `/api/health` no-store, version 1.6.1.
14. Feature freeze: fixes from the user test, design polish, stretch only if all green; video; submit.

## 8. Cut list (we will NOT build)

- No WhatsApp/Instagram integration, and no logos of either anywhere.
- No seller login or accounts: one demo seller, with a separate table per browser (a cookie; changed 31 Oct), shared with a phone only through a one-time QR.
- No database: JSON files (Render free disk resets on restart → every table starts empty; invoice status always comes from PayPal).
- No webhooks (stretch goal only).
- No React or build step.
- No AG Grid Enterprise features (no row grouping, no Excel `.xlsx` export, no Side Bar).
- No live (real-money) PayPal: sandbox only.
- No sending emails; no PayPal `remind` endpoint (stretch goal only).
- No menu editor in the UI (edit `data/menu.json`).
- No images, voice notes or stickers in chats: text only.
- No inventory, delivery routing or multi-seller support.
- No chat-style "ask the agent" box: every question would burn AI quota.
- The AI never sends invoices or messages by itself: the seller always clicks to approve.
- No `PayPal-Request-Id` header for invoices: not documented for Invoicing, and not honoured in our sandbox test.

## 9. Checkpoints (2 h on weekdays; 6 h available on 31 Oct / 1 Nov / 7 Nov / 8 Nov, 5 h planned; ~46 h planned + 4 h buffer)

Weekend days have 6 h available (2 h + 4 h extra). The plan uses 5 h; the 6th hour each weekend day is buffer. Sat 31 Oct spends its buffer hour on a first Render deploy (a "walking skeleton": the thinnest version that runs end to end on the real host), so hosting problems show up early, not on 5 Nov. That leaves 3 h of buffer (1 Nov, 7 Nov, 8 Nov).

| Date | Goal | Done when |
|---|---|---|
| Sun 25 Oct (extra) | ✅ **Step 1 DONE early**: Express skeleton, page, AG Grid from CDN, config, error handler, tests + `npm run check` | `npm start` shows a page with an empty grid; CSV/flash/quick filter present in the bundle; `npm run check` passes |
| Mon 26 Oct (2 h) | ✅ **Step 3 DONE** (61 new tests): money.js + orders.js + dates.js + tests (moved up from Wed: pure logic, no UI, so it doesn't wait for the UI spec) | `npm test` passes, incl. "brwnies" → unclear, "cheese brownies" → cheese_brownies and the 8 date cases in Section 6 |
| Tue 27 Oct (2 h) | ✅ **Step 2 DONE** (`npm run ui-check`: 3 widths, Priya's edit survives a reload): AG Grid table + edits, select + date editors, **following the UI spec (Section 12)**. **You: fill in Section 12 from your sketch before this session** | Edits survive a page reload; the page matches Section 12 |
| Wed 28 Oct (2 h) | ✅ **Step 3b DONE early (Tue 27 Oct)**: perfect score, 17.6 s, real reply saved as `data/ai-cache/demo-parse.json` and used by mock mode. **AI reality check** (the day freed by finishing Step 1 early): one real gemini-3.6-flash call, **max 3 that day** | Call time + comparison with expected-orders.json printed and logged in DECISIONS.md; the real reply saved as the mock-AI data |
| Thu 29 Oct (2 h) | ✅ **Step 4 DONE early (Wed 28 Oct)**: 184 tests, `npm run ui-parse` at 1280 + 390 px. Step 4: parse with mock AI (= Wednesday's real Gemini reply) + unclear rows | Demo chats → final orders with totals, notes, unclear rows highlighted |
| Fri 30 Oct (2 h) | ✅ **Step 5 DONE early (Wed 28 Oct)**: 215 tests, `npm run ui-flow` at 1280 + 390 px, one real sandbox invoice. Step 5: create + send invoices per buyer + double-invoice guard. **You: draft the video storyboard (Section 13)** | Payer link + Copy work; double-click still gives one invoice per buyer; storyboard drafted |
| Fri 30 Oct (2 h) | **Step 10b: Kitchen list** (added 29 Oct, one session; uses the evening freed by finishing Step 5 early) | Per date, a count per item from active clear orders; cancelled left out; "+1 order still to check"; Copy works |
| Sat 31 Oct (6 h) | ✅ **Step 6 DONE early (Wed 28 Oct)**: 239 tests, `npm run ui-flow` at 1280 + 390 px, one real cash payment. **Still on Sat 31 Oct: the first Render deploy (buffer hour).** Step 6: polling, badges, Refresh, Reset demo; Paid flash + CSV export; pinned totals + quick filter; record cash/bank. **Buffer hour: FIRST DEPLOY to Render of whatever exists (walking skeleton)**, and check Render's free-tier rules (sleep after inactivity, monthly hours, whether it asks for a card; **if it asks for a card, stop and ask Jasper**) → note them in DECISIONS.md | Paid in sandbox → cell flashes green; cash → "Paid (cash)"; CSV opens in Excel; **the app loads from a Render URL** |
| Sat 31 Oct (rest of the day) | ✅ **Step 10c DONE (Sat 31 Oct)**: 459 tests, `npm run ui-pickup` at 1280 + 390 px with a real PayPal QR through the fake camera; a real phone is Jasper's check. **Step 10c: Pickup scan** (added 29 Oct, one session; the hours freed by finishing Step 6 early). It needs HTTPS, so it follows the first Render deploy and is tested there. **Dropped first if time is tight** | On a phone over the Render URL: scan a sandbox invoice QR → green "Paid: ..." or amber "Not paid yet: ..." → Collected; typing the invoice number works without a camera |
| Sat 31 Oct (extra) | ✅ **Step 10d DONE (Sat 31 Oct)**: Open on my phone + Save QR, `npm run ui-pair` (laptop + phone contexts), live on Render; a real phone is Jasper's check | Pair -> the phone sees the same table -> the phone scans -> Collected shows on the laptop after Refresh |
| Sun 1 Nov (5 h) | ✅ **Step 7 DONE early (Thu 29 Oct)**: perfect score on the new chats, 21 s, 2 of 6 calls; 282 tests; ui-check + ui-flow at 1280/820/390. Step 7: real Gemini + cache; buyer panel (note + highlighted messages); pickup QR; **price mismatch + messier demo chats (added 29 Oct)** | Real call once, cached after; clicking Arif shows his 2 messages + a QR; the wrong price mention shows "Check: buyer mentioned ..., menu says ..."; the new expected-orders.json scored against Gemini's real reply, saved as the demo cache. **You: holdout chats + expected answers saved** |
| Mon 2 Nov (2 h) | ✅ **Step 8 DONE early (Thu 29 Oct)**: `--cached` 74/74, 310 tests; the one live run got 503 from both models (no live score yet). Step 8: accuracy.mjs + prompt tuning | Score printed; demo chats give the totals in the updated expected-orders.json (was 7 orders / RM 387.00 before Step 7) |
| Tue 3 Nov (2 h) | ✅ **Step 9 DONE early (Fri 30 Oct)**: 323 tests, `npm run ui-ai` at 1280 + 390 px; the live run got Google busy again (no score). Step 9: timeout, retry, backup, counter | "AI calls left" shown; quota 0 → friendly "AI busy" message |
| Wed 4 Nov (2 h) | ✅ **Step 10 DONE early (Fri 30 Oct)**: 345 tests; Read without AI (demo: 1 clear, 9 unclear), Copy message / reminder / question (code only), chips fixed. Step 10: ready-to-send messages + reminders; **"Copy question" on unclear rows (added 29 Oct)** | Every invoiced buyer has a copyable message with the real total + link; Priya's row copies "Hi Priya! Which brownies would you like: Classic (RM 18.00) or Cheese (RM 22.00)?" with prices from the menu |
| Thu 5 Nov (2 h) | ✅ **Step 11 DONE early (Fri 30 Oct)**: live at https://chatching.onrender.com/, `npm run ui-live` at 1280 + 390 px. Step 11: deploy to Render | **Full flow works on the hosted URL** |
| Fri 6 Nov (2 h) | 7 PM: **user test with your friend (10 min)** → LEARNING.md; then Step 12: ~~non-AI fallback parser~~ (done early in Step 10, 30 Oct) | Test notes saved; app works with `AI_MODE=off` (Read without AI) |
| Sat 7 Nov (5 h) | Edge-case tests; **holdout accuracy run (once)**; README (features, setup, testing logins = the 2 judge accounts); **video script draft** (from the Section 13 storyboard); **save a Devpost draft**. **You: create 2 sandbox buyer accounts just for judges**, in English so judges can read the payment page (if one gets locked or its password changed, judges use the other) | Holdout score recorded as-is; fresh clone runs from README alone; Devpost draft saved; both judge logins work |
| Sun 8 Nov (5 h) | **Feature freeze.** Fixes from the user test, design polish, buffer; stretch only if all green. **Polish (added 29 Oct): a soft "cha-ching" when a payment arrives**, made in code with the Web Audio API (no sound file, no copyright), **plus the Paid total counting up**. Only after the seller has clicked something on the page (browsers block sound before that), with a mute toggle; with reduced motion, no count-up animation (the number just changes) | All RULES.md build items ticked; a sandbox payment plays the sound once; mute silences it; reduced motion shows no animation |
| Mon 9 Nov (2 h) | **First: test paying with an English-language sandbox buyer account** (one of the judge accounts), then record the video | Payment page in English; video under 3 min, no copyrighted music/logos |
| Tue 10 Nov (2 h) | Video upload, GitHub public + MIT in About, Devpost details | All links work in a private window |
| Wed 11 Nov (2 h) | "final check", then **submit (evening)** | Devpost shows Submitted |

Hard deadline: 13 Nov 2026, 4:00 AM MYT. Hosted demo and sandbox logins must keep working until 16 Dec 2026.

**Tightest part:** Mon 2 – Fri 6 Nov has ~11 h of work in 10 h, and Fri 6 Nov has two jobs. If it slips, it spills into the buffer hour on 7 or 8 Nov. If that isn't enough, cut in this order: 3 first, then 2, then 1, keeping 5 and 4.

**Added 29 Oct:** Steps 10b and 10c go into the evenings freed by finishing Steps 5-6 early (Fri 30 Oct, Sat 31 Oct), so the Mon-Fri crunch doesn't grow. Step 7 also grew (price mismatch, messier chats); Sun 1 Nov's buffer hour covers it. If anything slips, **Step 10c (Pickup scan) is dropped first**, before the Top 5 cuts above. Feature freeze stays Sun 8 Nov.

### After submission (12 Nov – 16 Dec)

Judging runs until 16 Dec, and judges need free access the whole time.

**Frozen after the deadline** (official rules, Section 5: "Once the Submission Period has ended, you may not make any changes or alterations to your Submission."):
- [ ] Right after submitting: tag the submitted commit and push the tag: `git tag submission`, then `git push origin submission`. From then on `main` is frozen.
- Only maintenance: restarting Render, renewing keys in Render's settings, fixing judge logins. **No code or README changes.**
- If the code ever needs a fix, ask Devpost in writing first, and wait for their answer.

**Every 2–3 days:**
- [ ] The hosted URL loads (a slow first load can be Render waking the free service up).
- [ ] Both judge logins work at https://www.sandbox.paypal.com.
- [ ] The PayPal sandbox app still works: `node --env-file=.env scripts/smoke-paypal.mjs` → "token OK: yes" (same keys as on Render).
- [ ] The Gemini key still works and the model still exists (models get retired): `node --env-file=.env scripts/smoke-gemini.mjs` (1 call).
- [ ] Render hasn't paused or suspended the service (the dashboard shows it live).
- [ ] Write the date and results in the log below. Fix anything that fails the same day (maintenance only, see "Frozen after the deadline" above).

| Date | URL loads | Judge login 1 | Judge login 2 | PayPal | Gemini | Render live | Notes |
|---|---|---|---|---|---|---|---|

## 10. Standout features (Top 5)

Chosen 2026-10-25. If time runs short, keep in this order: **5, 4, 1, 2, 3** (cut 3 first).

### 1. "Show your work" (0 extra AI calls)
- The parse call also returns a one-line `note` per order, e.g. "Changed from 2 to 3 boxes in message 4." or "Cancelled in message 13.". Max 120 characters, plain text.
- Clicking a row opens the **buyer panel** on the right. It shows the note, plus the full chat with that buyer's `sourceMsgs` highlighted and the rest dimmed.
- The panel is our own HTML, because AG Grid's Side Bar is Enterprise. Features 2 and 3 reuse it for the message, the QR code and the record-cash button.

### 2. Ready-to-send message per buyer
**Changed 30 Oct (Step 10, Jasper): code templates only, no AI** ("AI calls are scarce; the AI's job is reading chats"). Built in `src/messages.js`: Copy message (sent invoices), Copy reminder (unpaid), Copy question (unclear rows); exact texts in DECISIONS.md. The AI design below is kept for the record but not built.
- **One batched AI call** for all invoiced buyers. For each buyer the AI returns friendly English wording with placeholders only: `{items}`, `{total}`, `{date}`, `{link}`.
- **Our code fills in the placeholders** from the table and PayPal, so the AI can never write a price or a link.
  - Example from the AI: `Hi Lina! Your order of {items} is ready for {date}. The total is {total}, you can pay here: {link}`
  - Filled in by our code: `... Your order of 3 × Classic brownies (box of 6) is ready for Sat 31 Oct. The total is RM 54.00, you can pay here: https://www.sandbox.paypal.com/invoice/p/#INV2-...`
- **Checks:** the wording must contain `{total}` and `{link}`. It must not contain money ("RM", "$", numbers like 18.00) or web addresses. If it fails, that buyer gets the template instead.
- **Template fallback:** one English message template (and one reminder template), used when there is no AI.
- **Reminders use the same design:** same call shape, same checks, reminder templates.
- Shown in the buyer panel and in a "Messages" list, each with a Copy button.
- Cost: one call per batch of invoices and one per reminder round. With "Reset demo", judges get saved results (0 calls).

### 3. PayPal as the seller's one record of payments
All three were tested in sandbox on 2026-10-25 with `scripts/smoke-invoice.mjs` (`--record-cash`, `--qr`, `--idem-test`).

| Part | PayPal API | Sandbox result |
|---|---|---|
| a. Record cash / bank transfer | `POST /v2/invoicing/invoices/{id}/payments` with `method` (`CASH` or `BANK_TRANSFER`), `payment_date`, `amount` | `UNPAID` → **`MARKED_AS_PAID`**, payment listed as CASH. (The docs say `PAID`; the real status is `MARKED_AS_PAID`.) |
| b. Pickup QR code | `POST /v2/invoicing/invoices/{id}/generate-qr-code` with `action: "pay"`, 150-500 px | HTTP 200, `multipart/form-data` with a Base64 PNG in a part named `image`; decoded to a valid QR image. The invoice must be sent first. |
| c. No double invoices | `PayPal-Request-Id` header | **Not documented for Invoicing and NOT honoured**: the same ID gave 2 different invoices. Not used. |
| | Unique `invoice_number` | PayPal **refuses a duplicate** with `422 DUPLICATE_INVOICE_NUMBER`. Used as PayPal's own guard. |

- **a.** A "Record cash / bank transfer" button in the buyer panel, with a confirm step (no undo planned). The table shows "Paid (cash/bank)".
- **b.** ~~Shown only when `fulfilment` is `"pickup"`.~~ **Changed 29 Oct (Step 7):** shown in the buyer panel for every SENT invoice (Jasper's Step 7 prompt), because any buyer can scan it to pay and Step 10c scans it at pickup. Loaded when the drawer opens, asked from PayPal once per invoice and kept in memory. The server reads the Base64 PNG out of the multipart reply.
- **c.** Three layers:
  1. The server skips buyers that already have an invoice.
  2. A per-buyer "in progress" lock, with the button disabled while sending, so a double-click can't create two.
  0. (1 Nov) Between batches: reading compares buyers with the visitor's saved batches of the same Chat date; a repeat is unclear until Send anyway. Reset demo starts over and raises no check.
  3. Every invoice gets `invoice_number` = `CHATCHING-{batch}-{nn}`, e.g. `CHATCHING-K3F9Q2ZA7L1X-07`. The batch is 12 characters (8 until 31 Oct: numbers must stay unique across all visitors), so the number is exactly PayPal's max of 25. The batch changes on every parse and every Reset demo, so PayPal itself rejects a repeat. On `DUPLICATE_INVOICE_NUMBER`, the server looks that invoice up by its number and uses it (changed 28 Oct, Step 5; verified on the real sandbox).

### 4. AG Grid extras (both Community, checked in AG Grid's module list)
- **"Export CSV (opens in Excel)"** → `api.exportDataAsCsv()` (CsvExportModule, Community).
  - Real `.xlsx` export (`ExcelExportModule`) is **Enterprise**, so we don't use it.
  - Risk: Excel can garble emoji and accented names in a CSV. If it does, add a byte-order mark (BOM), a hidden marker that tells Excel the file is UTF-8.
- **The status cell flashes green when it turns Paid.** Polling notices the change, then calls `api.flashCells({ rowNodes, columns: ["invoiceStatus"] })` (HighlightChangesModule, Community).
  - The colour comes from the CSS variable `--ag-value-change-value-highlight-background-color`.
  - Only the change to Paid flashes, not every change.

### 5. Real-seller proof
- **Holdout chats:** the folder `data/holdout/` (git-ignored) holds your friend's real messages and the answers you write yourself (e.g. `data/holdout/chats.txt` + `data/holdout/expected.json`).
  - **Rule (29 Oct):** before any real chat is committed, names and phone numbers are replaced AND the seller agrees. Until then the folder stays git-ignored; `npm run check` fails if anything in it is tracked.
  - **You save both by Sun 1 Nov**, before prompt tuning (Mon 2 Nov). We don't open them while tuning.
  - `node --env-file-if-exists=.env scripts/accuracy.mjs --live --chats data/holdout/chats.txt --expected data/holdout/expected.json --date <YYYY-MM-DD>` runs **once**, on Sat 7 Nov. The score is recorded as-is, even if it's low.
  - **The result is never used to tune the prompt afterwards.** Once we have seen the holdout mistakes, the set is no longer "unseen", so any later score on it would not be honest. Its report stays out of git (`tmp/`); only the score is quoted.
  - **Changed 1 Nov (Jasper):** for the two test sets in Step 8, scores and differences ARE committed in `docs/accuracy.md`; their chats, menus and expected answers never are. The 7 Nov run happens only if new real chats arrive.
  - **Privacy:** Google's free-tier terms say "Do not submit sensitive, confidential, or personal information" and that "human reviewers may read" inputs. So also remove addresses, places and anything personal. Your friend's permission must cover a **public GitHub repo** and **Google's free tier**.
  - `data/README.md` gets a line saying the holdout chats are real but anonymised. Everything else stays fictional.
- **User test:** Fri 6 Nov, 10 minutes, your friend on the hosted app.
  - Give 3 tasks: paste a day of chats → fix the unclear rows → send invoices and copy a message.
  - Don't help. Note what confused them in LEARNING.md. Fixes go into Sun 8 Nov.

## 11. Stretch list (only after Sections 7 and 10 work)

In suggested order:
1. **Mask phone numbers before AI calls.** Cheap, and fits the free-tier privacy rule.
2. ✅ **Judge-first screen:** a 3-step guide, a "Load demo" button and money summary cards (orders, invoiced, paid). (Guide + cards built in the design rounds; Load demo built 28 Oct: fills the chat box, Read orders still reads.) It helps the Design and Presentation scores.
3. **Quick-fix buttons for unclear rows,** e.g. "Classic" / "Cheese" for "which brownies?".
4. **README trust signals** + a GitHub Actions test badge.
5. ~~**Screenshot input:** a picture of the seller's own plain chat text only (no app logos). It costs AI quota.~~ **Rejected 29 Oct** (accuracy, AI quota, app logos in the video; see DECISIONS.md). Listed under "What's next" in the Devpost draft.
6. **Already planned as stretch:**
   - PayPal `remind` endpoint.
   - Webhooks.
   - ~~Finding the existing invoice after `DUPLICATE_INVOICE_NUMBER`, via invoice search.~~ Built in Step 5 (28 Oct).

## 12. UI spec (filled in Mon 26 Oct)

> **DESIGN FROZEN (Tue 27 Oct, again after the browser-test fixes) until Sun 8 Nov** (the planned polish day). Round 3 + the browser-test fixes were the last design changes: no visual changes before 8 Nov except bug fixes and what new features need (e.g. the Send invoices button in Step 5), following these rules.

**Every UI step must follow this spec** (Steps 2, 4, 5, 6, 7 and 10), **and must be checked at laptop, iPad and phone widths** (1280 px, 820 px and 390 px, with `npm run ui-check` AND by looking at the screenshots). If a step needs something the spec doesn't cover, Claude asks before inventing it.

Goal (Jasper): clean but informative, warm, and working on every type of device.

### Colours: few, each with one job (design round 2, Tue 27 Oct; replaces the cream/navy palette of 26 Oct)

| Colour | Hex | Job (only this) |
|---|---|---|
| Warm ultra-light grey | `#F7F5F2` | page background *(replaces cream `#FBF7F0`)* |
| White | `#FFFFFF` | cards and the table |
| Deep brand indigo | `#26307A` → `#33409A` | **the Expected hero card only** (white on it: 11.76 / 8.97; its pale text `#D4D7F0`: 6.31) |
| Rich charcoal | `#1D1D1F` | headings and primary text *(replaces navy `#1F2A44`)* |
| Secondary grey | `#6E6E73` | secondary text, table headers, subtext *(replaces `#5B6270`; `#86868B` is too faint: 3.62:1)* |
| Warmer blue | `#3A5BC7` (hover `#3150B4`) | **clickable only**: buttons (white text), links, the quiet "Edit" button's text, focus ring *(replaces `#1D4E9E`)* |
| Warm amber | `#E0A030` + tint `#FCEFD6` | **"check this" only**: unclear rows, the Needs check card, warnings, errors |
| Green tint | `#DCF2E3` + text `#1E5B35` | **money arrived only**: Paid tags, the Paid card once something is paid |
| Hairline | `#EFEBE5` | the line between buyers in the table (decorative) |
| Input border | `#8C8270` | the ONLY visible borders: text boxes and the date picker, so people can see where to type |

**Colour rule (reworded 27 Oct, round 3):** **bright blue `#3A5BC7` = clickable**, amber = check this, green = money arrived. The **deep brand indigo `#26307A`/`#33409A` is used only for the Expected hero card** (it is clearly darker than the button blue and never on anything clickable). Nothing else gets colour. The logo, avatars, chips and icon circles are charcoal on neutral.

**Status tags:** borderless pills, a soft muted tint with matching darker text, plus a Lucide icon (laptop and iPad; phones show the words only).

| Tag | Background | Text |
|---|---|---|
| Draft | warm beige `#F3ECE1` | `#5C4A30` |
| Sent / Part paid | light blue `#E3EBF8` | dark slate `#2B3A55` (not blue: tags aren't clickable) |
| Paid / Paid (cash/bank) | green tint `#DCF2E3` | `#1E5B35` |
| Cancelled/Refunded | grey `#EEEEF0` | `#636368`, strikethrough |

**Unclear rows and warnings:** amber tint `#FCEFD6` behind the row, a 4 px amber stripe on its left edge, **plus the words "Check: \<reason\>"** in charcoal. Secondary grey is never used on amber (4.46:1, just under AA); text there is charcoal.

**Contrast check (WCAG AA: 4.5:1 text, 3:1 input borders), measured 2026-10-27:**

| Pair | Ratio | Result |
|---|---|---|
| charcoal on the page / on the amber tint | 15.47 / 14.79 | ✅ |
| secondary grey on white / on the page | 5.07 / 4.66 | ✅ |
| secondary grey on the amber tint | 4.46 | ❌ so charcoal is used there |
| white on the blue button / on its hover | 6.00 / 7.15 | ✅ |
| blue text on white / on the page / on the Edit button tint (hover) | 6.00 / 5.51 / 5.31 (4.90) | ✅ |
| Draft, Sent, Paid, Cancelled tag text on its tint | 7.22, 9.52, 6.86, 5.16 | ✅ |
| input border `#8C8270` on white | 3.79 | ✅ (3:1 needed) |
| amber `#E0A030` as text | 2.27 | ❌ so amber is never text |

### Type
- Font stack: `-apple-system, BlinkMacSystemFont, "Inter", sans-serif` (Jasper's choice). Apple devices get San Francisco. **Inter is served from our own server** (`public/fonts/`, Latin subset, 48 KB, SIL Open Font License) because Windows and Android don't have it, and without it `sans-serif` would be Arial.
- Page title "Today's orders" 44 px bold (34 px phone); section headings 22 px; body 16 px; table 15 px (14 px phone); table headers 13 px secondary grey; quiet details 13-15 px secondary grey. Sentence case everywhere; no all-caps labels.
- **Summary numbers:** Expected is the hero, 60 px bold (44 px phone); the other three 36 px semibold (22 px phone).
- Money is right-aligned with tabular numbers, so the digits line up.

### Layout

| Width | Layout |
|---|---|
| **Laptop** (≥ 1024 px) | Summary row: Expected (indigo hero) + Orders, Paid, Needs check. Chats on the left, table on the right; once orders are read, the chats fold into a slim bar and the table takes the full width. **One row per buyer**, columns Buyer, Items, Date, Total, Status + a blue chevron. Tapping a row opens the **buyer drawer** from the right. |
| **iPad** (641–1023 px) | Expected full width on top, the other three cards below. Same table without the Date column: the date sits under the buyer's name ("2 items, Fri 30 Oct"). The drawer slides in from the right. |
| **Phone** (≤ 640 px) | Everything stacked. **Each buyer is a stacked card** (avatar, name, items and date, total + status on the right, item chips below, "Check:" words if needed); no table header. The drawer is **full screen**. A sticky frosted bottom bar shows the total (and "Send invoices" from Step 5); it replaces the pinned totals row. |

- Tap targets are at least 44 × 44 px on every device.
- Breakpoints 640 / 1024 px (Claude's choice). A landscape iPad (1180 px) gets the laptop layout. Side gutters 16 px.
- **Slim chat bar:** after "Read orders" the chat box folds into a bar "15 messages read from 28 Oct" + an "Edit" button (blue text = clickable) that opens the chats again, filled with the messages that were read; "Hide chats" folds it back. The server remembers the chats with the rows (`source` in the store).
- **Footer:** setup details (menu, AI mode, PayPal/Gemini keys) sit in a small quiet footer, not in the seller's way. A friendly warning appears only when it matters, next to the action it blocks (Step 5: "Send invoices" while the PayPal keys are missing).

### 3-step guide
- At the top: **1 Paste → 2 Review → 3 Get paid**, each with a Lucide icon in a white circle. The current step is a filled charcoal circle and bold text; the others are secondary grey. Not blue, because the steps aren't buttons.
- Current step rule: no rows yet → 1; rows but no invoices → 2; any invoice sent → 3.

### Design principles (rounds 1-3, Tue 27 Oct; round 3 is final until 8 Nov)

Jasper's reasons: round 1 "the original design is too simple"; round 2 "no personality and no focus"; round 3 "the page is too compact, has no real icons, and the list is too long". Round 3 matched the QUALITY cues of a banking-app reference (colour confidence, big numbers, generous space, icons in soft circles, short card-like lists), not its branding or layout.

- **One focus:** the Expected figure is the hero: a **solid deep indigo card** (`#26307A` → `#33409A` subtle gradient, 24 px corners, a soft lighter sweep in one corner) with **large white numbers** (68 px; 48 px phone), like a bank card. Everything else stays white and quieter.
- **Background:** 2-3 soft, heavily blurred colour shapes behind the cards (CSS only, `filter: blur(90px)`): very light brand blue `#F3F6FF` (top right, bottom right) and warm cream `#FFF6E8` (left). Their colours are **never darker than the page**, so no text loses contrast: secondary grey is 4.69:1 on the blue and 4.73:1 on the cream (4.66:1 on the plain page). `npm run ui-check` measures this.
- **Depth without borders:** no outer borders on cards, the chat container or the table; one soft diffused shadow `0 4px 24px rgba(0,0,0,0.04)` on every card. Only inputs have visible borders.
- **Radii:** at least 16 px on all main containers and inputs: work cards 24 px, summary cards 20 px (18 px phone), the table 16 px, textarea and date picker 16 px, buttons and tags fully rounded.
- **Whitespace:** page top 48 px; 24-32 px between sections; summary cards 28 px padding, work cards 32 px (28/20 iPad, 24/16 phone); buyer rows at least 92 px tall with 24 px top and bottom padding; header 52 px. Body text 17 px (16 px phone), table 16 px, page title 48 px (36 px phone).
- **No vertical lines in the table:** no column borders, no header dividers, no resize handles. Rows have no lines between them; one hairline separates buyers.
- **One row per buyer (our own grouping; AG Grid's row grouping is Enterprise):** the server's `buyerGroups()` gives each buyer's rows and subtotal; the page builds one table row per buyer: a soft initials avatar + name (+ "2 items", "Needs a check" or "Cancelled"), the items as **compact chips** ("3 × Classic brownies" with a food icon from `menu.json`), the delivery date, the buyer's total and ONE status tag. Unclear buyers get the amber tint + stripe and the "Check: <reason>" words under the chips. A blue chevron in a soft blue circle says "this row opens" (blue = clickable).
- **Needs check card = a filter button:** clicking it shows only the buyers that need a check (an amber note above the table says "Showing 1 buyer that needs a check." with a Show all button); clicking again shows everyone. A blue "Show only these ›" cue says it is clickable (blue = clickable); when it is filtering it gets a 2 px blue ring. With 0 to check it can't be clicked, and if the last one is fixed while filtering, the filter switches itself off. On phones this card is full width (it is the one you tap).
- **Search and Export CSV** sit above the table: a pill-shaped search box ("Search buyers or items", AG Grid quick filter over the buyer name and item names) and a quiet "Export CSV" pill. No match: "No buyers match. Clear the search, or show all buyers." The CSV has every buyer (whatever the search or filter shows), columns Buyer, Items, Date, Total (MYR) as a plain number, Status, and starts with a UTF-8 byte-order mark so Excel shows "×" and accented names correctly. File name `chatching-orders-<chat date>.csv`.
- **Pagination:** AG Grid Community pagination, **6 buyers per page**, with our own round arrow buttons and "Page 1 of 2" under the table (AG Grid's own panel is hidden). One row = one buyer, so a buyer is never split across pages. Disabled arrows are grey, not blue.
- **The buyer drawer (editing):** tapping a buyer opens a drawer (480 px from the right on laptop/iPad, full screen on phones) with one white card per item: the item's food icon, name and line total, then simple form fields: **Item** (dropdown with names and prices), **Qty** (1-99) and **Date**. Each change saves at once with the same `PUT /api/orders/:id`; the drawer, table and cards update from the server's reply. Unclear items are amber cards with the "Check:" words; cancelled items are read-only. A quantity outside 1-99 is stopped in the drawer with the server's own wording (no request is sent, so the browser logs no red 400 error); the server still checks everything. Escape, the close button or the dimmed page closes it; Tab stays inside it while open.
- **Sticky frosted-glass top bar** with the logo mark (an inline SVG: chat bubble + coin, charcoal), the ChatChing wordmark and "AI calls left today: X".
- **Pill buttons:** "Read orders" is a fully rounded warmer-blue pill with a soft hover transition (colour + glow); secondary actions ("Edit", "Hide chats") are quiet pills with blue text on a pale blue tint.
- **Hover lift (scale 1.02) on the summary cards only,** only with a mouse and when reduced motion is off; scaling the big table would blur its text and shift its editors.
- **Icons: Lucide 1.55.0** (jsDelivr, pinned, integrity hash, ISC licence), 20-24 px, **inside soft tinted circles (40-44 px)** on the summary cards and steps (neutral tint; the Paid card's circle is green; on the hero it is white at 14%). **Food icons on the item chips** come from an optional `"icon"` field per item in `data/menu.json` (Lucide names, e.g. "cookie", "cake-slice"), so a seller can change them. Always next to words; never amber; no emoji. The page works without them.
  - Status icons: Draft = pencil-line, Sent = send, Part paid = hourglass, Paid = circle-check, Paid (cash/bank) = banknote, Cancelled = circle-x.
- **Summary cards: Expected (hero), Orders, Paid, Needs check,** counted per buyer by the server (`summary()`; the page does no money maths). They change colour with the facts: Needs check turns amber (tint + stripe) above 0; Paid turns green once money arrives.

### AG Grid
- Quartz theme via `themeQuartz.withParams({...})` (names checked in the 36.2.0 file): white background and header, charcoal text, secondary-grey 14 px headers, rows at least 92 px, a hairline between buyers (`rowBorder`), pagination with `suppressPaginationPanel`, accent = the warmer blue; `wrapperBorder`, `columnBorder` and `headerColumnBorder` off; resize handles transparent; row hover `#FAF8F5` and selected `#F5F1EB` (warm, not blue); font = the stack above.

### Errors (decided Mon 26 Oct)
- Errors (for example "PayPal is not working right now") use the **amber tint `#FCEFD6` + the word "Error:"** in charcoal, so the colour rule stays: amber = check this. No red anywhere. Jasper's reason: "because its clearer".

## 13. Video storyboard (Jasper, 28 Oct)

Drafted by Jasper on Wed 28 Oct; **table replaced on Thu 29 Oct** (signature moments: changes and price mismatch, Copy question, cha-ching, Kitchen list, Pickup scan). The words come later: video script on Sat 7 Nov, recording on Mon 9 Nov.

**Video rules:** under 3:00; captions on every scene (judges may watch muted); no copyrighted music; no third-party logos (no WhatsApp/Instagram); sandbox accounts only. Also from RULES.md: public on YouTube, shows the app working end to end.

| # | Time | On screen | Caption | Moment the app must have | Built in step |
|---|---|---|---|---|---|
| 1 | 0:00-0:12 | Messy order chats (our own plain text, no app logos) | "Small sellers take orders by chat, then copy them into Excel by hand." | The messier `data/demo-chats.txt` shown as plain text | Step 7b (messier chats) |
| 2 | 0:12-0:25 | Paste the chats, Chat date | "ChatChing: paste a day of chats." | Chat box + Chat date (+ Load demo) | ✅ Step 4 |
| 3 | 0:25-0:55 | Read orders: a change of quantity, "same as Lina", a cancellation, the price mismatch in amber | "AI reads the language. The code supplies the facts." | Real Gemini reply cached; amber "Check: buyer mentioned RM 15.00, menu says RM 18.00." | Step 7 (7a + 7b) |
| 4 | 0:55-1:10 | Priya amber -> Copy question | "Unclear? Ask the buyer in one tap." | "Copy question" with names, items and prices filled by the code | Step 10 |
| 5 | 1:10-1:35 | Send invoices with the progress bar, click again -> nothing new | "One click: one PayPal invoice per buyer. Never twice." | Send invoices, progress bar, "All invoices sent", double-invoice guard | ✅ Step 5 |
| 6 | 1:35-1:55 | Buyer pays in the sandbox -> cha-ching, the row turns green | "See who paid, live." | Polling + Paid flash ✅ Step 6; cha-ching + Paid total counting up | Sun 8 Nov polish |
| 7 | 1:55-2:10 | Kitchen list | "Know what to bake, per day." | Kitchen list per date + Copy | Step 10b |
| 8 | 2:10-2:30 | Phone scans the buyer's QR -> Paid -> Collected | "Hand over only when paid." | Pickup scan on the Render URL (HTTPS) | Step 10c |
| 9 | 2:30-2:45 | Tech view: PayPal Invoicing API, Gemini, AG Grid, tests | "Built on PayPal, Gemini and AG Grid." | `npm run check` output; architecture picture from the README | Step 13 (README) |
| 10 | 2:45-2:50 | Logo | "ChatChing: from chat to cha-ching." | The logo mark | ✅ Step 2 |

Notes (Claude): the scenes add up to 2:50, leaving 10 s of margin under 3:00. Scene 6 needs a sandbox buyer login (the judge accounts, Sat 7 Nov) and English payment pages (Mon 9 Nov); its sound must be our own Web Audio tone (no copyrighted audio). Scene 8 needs a real phone on the Render URL. **If Step 10c is dropped,** scene 8 shows the pickup QR in the buyer panel + "Record cash" instead (both already planned or built). Scene 1 shows our own plain-text chats, never a chat app's screen.
