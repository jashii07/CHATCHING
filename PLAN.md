# PLAN — Chat-to-Checkout

Status: APPROVED 2026-10-25 (with changes). Build starts Mon 26 Oct, 7 PM MYT.

## 1. Problem

Small home sellers in Malaysia take orders as messy chat messages in mixed English/Malay ("kak nak 2 brownies hantar sabtu"). They copy orders into Excel by hand, work out totals, then chase each buyer for payment one by one. It is slow and things get missed.

## 2. User

- **Main user:** a home seller (cakes, kuih, frozen food) with a small fixed menu and 10-50 chat orders a day. Not technical.
- **Judges:** log in as that seller (shared sandbox demo) and pay as a buyer with a sandbox personal account.

## 3. Flow

1. **Paste:** the seller pastes a day of chat messages into a text box.
2. **Read (AI, 1 call):** Gemini turns all messages into the **final order per buyer**. It applies changes, add-ons and cancellations from later messages, resolves delivery dates, and flags anything unclear with a reason. The AI never sets prices.
3. **Review:** rows appear in an AG Grid table, one row per item, so a buyer can have several rows. The code fills in the price from the menu and calculates the totals. The seller fixes unclear rows by editing cells.
4. **Invoice (no AI):** one click creates and sends one PayPal sandbox invoice per buyer, grouping that buyer's rows, without emailing anyone. Cancelled and unclear rows are skipped. The table shows each buyer's payer link with a "Copy" button for pasting into the chat.
5. **Track:** status moves Draft → Sent → Paid. The page asks PayPal for the latest status (polling) when you click "Refresh status", and automatically every 20 s while the page is open.
6. **Remind (AI, 1 call):** for all unpaid buyers, Gemini drafts friendly reminders in one call. Each has a "Copy" button. If there is no AI, a template is used instead.

**Golden rule:** a payment never waits on the AI. Steps 4-5 make no AI calls.

## 4. Architecture A: one simple server

One Node 24 server (Express) serves the page and the API. The page is plain HTML + JavaScript, with AG Grid Community **36.2.0** loaded from jsDelivr. There is no build step. All keys stay on the server.

```
server.js                 Express app: routes + serves public/
src/paypal.js             token (cached in memory) + create/send/get invoice
src/ai.js                 Gemini: one batched call, timeout, retry, backup model, cache, mock mode
src/fallback.js           non-AI: alias-based parser + template reminders
src/orders.js             pure logic: prices from menu, totals, group rows by buyer, status mapping
src/dates.js              message timestamps + day words ("esok", "sabtu", "Friday") -> dates
src/store.js              saves orders + AI usage counter to data/*.json
public/index.html         the page
public/app.js             AG Grid table, buttons, polling
public/styles.css
data/menu.json            fixed menu (item -> price, aliases)
data/demo-chats.txt       fictional mixed English/Malay chats
data/expected-orders.json correct answers for demo-chats.txt
data/holdout-chats.txt    (later) 8-10 chats never used while tuning the prompt
data/ai-cache/            saved AI results (key = hash of input); includes the preloaded demo
test/                     node:test tests (built into Node, no package)
scripts/                  smoke tests + accuracy.mjs
```

Only one new package is planned: **express**.

### Routes

| Route | What it does | AI? |
|---|---|---|
| `GET /` | the page | No |
| `GET /api/state` | menu, orders, "AI calls left today", AI mode | No |
| `POST /api/parse` | chat text → order rows (replaces the current rows) | 1 call, or cache/fallback |
| `PUT /api/orders/:id` | save one edited row | No |
| `POST /api/invoices` | create + send one invoice per buyer that has no invoice yet | **Never** |
| `POST /api/invoices/refresh` | ask PayPal for the status of every open invoice | No |
| `POST /api/reminders` | draft reminders for all unpaid buyers | 1 call, or template |
| `POST /api/reset` | reload the demo orders + saved AI results | **0 calls** |

### AG Grid showcase (Community features only, no Enterprise)

| Feature | Used for |
|---|---|
| Select cell editor (`agSelectCellEditor`) | pick a menu item; the price updates from the menu |
| Date cell editor | fix a delivery date |
| Custom cell renderer: status badge | Draft / Sent / Paid / Cancelled in colours |
| `rowClassRules` | highlight unclear rows (and grey out cancelled ones) |
| Custom cell renderer: Copy-link button | copy the payer link for the chat |
| Pinned bottom row | totals: number of orders and RM total |
| Quick filter search box | find a buyer or item fast |

**Not used:** row grouping, because it's an Enterprise feature. Rows are grouped per buyer in our own code instead. In step 2, check that each feature works with the Community bundle from the CDN.

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

**What the AI returns**: the **final** order per buyer (forced JSON format, no prices):
```json
{ "orders": [
  { "buyer": "Lina", "status": "active", "sourceMsgs": [1, 4],
    "items": [ { "itemId": "classic_brownies", "qty": 3 } ],
    "deliveryDate": "2026-10-31", "unclear": false, "reason": "" },
  { "buyer": "Priya", "status": "active", "sourceMsgs": [7],
    "items": [ { "itemId": null, "qty": null } ],
    "deliveryDate": null, "unclear": true, "reason": "\"Same order as last week\": items not stated." }
] }
```
- `status`: `"active"` or `"cancelled"`. The AI applies changes ("tukar jadi 3"), add-ons ("add 1 jar cookies") and cancellations ("cancel la") from later messages.
- `sourceMsgs`: the message numbers used, so the seller can see where each order came from.
- `itemId` can be `null` when unclear.
- Questions ("ada lagi tak bahulu?") and payment requests ("send link payment") are **not** orders. They appear only in `sourceMsgs` if they belong to a real order.

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
  "deliveryDate": "2026-10-31", "unclear": false, "reason": "", "sourceMsgs": [1, 4],
  "invoiceId": null, "payerLink": null, "invoiceStatus": "Draft" }
```
- Money is calculated in sen (whole numbers) to avoid rounding errors, then shown as "54.00".
- Invoices group rows per buyer. A buyer is invoiced only when all their active rows are clear.

**Accuracy check:** `data/expected-orders.json` holds the correct answers for the demo chats: 7 clear orders worth RM 387.00, 1 unclear, 1 cancelled and 1 non-order. `scripts/accuracy.mjs` compares the parser's output against it (see Section 7).

**Invoice status**: PayPal's status → what the app shows:

| PayPal | App |
|---|---|
| (no invoice yet), `DRAFT` | Draft |
| `SENT`, `UNPAID`, `SCHEDULED`, `PAYMENT_PENDING` | Sent |
| `PARTIALLY_PAID` | Part paid |
| `PAID`, `MARKED_AS_PAID` | Paid |
| `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `MARKED_AS_REFUNDED` | Cancelled/Refunded |

Proven in the smoke test on 2026-10-25: MYR works; after sending, the status is `UNPAID`; the payer link is the `href` with `rel: "payer-view"` in the send response. After paying by hand with the sandbox personal account, `GET` shows `PAID` with a payment of 55.00 MYR, method `PAYPAL`, so polling works.

## 6. AI design

- **One batched call** per action. All messages go in one prompt, and the final order per buyer comes out. All reminders also come out of one prompt. The JSON shape is forced with Gemini's response schema. The prompt includes the menu ids and aliases, and the "plain brownies = unclear" rule.
- **Dates come from each message's own timestamp, not today's date.**
  - The code reads each message's `[28/10 9:02 AM]` and turns it into a full date with its weekday ("Wed 28 Oct 2026") before sending it to the AI.
  - So "esok" in a message from Wed 28 Oct is Thu 29 Oct, and "sabtu" is Sat 31 Oct. The demo gives the same dates in December.
  - A day name means the next such day after the message date. The year is the most recent year in which that day and month is not in the future.
  - `src/dates.js` does the same conversion without AI for the fallback parser. Our code then checks the AI's dates (Section 5).
- **Mock mode** (`AI_MODE=mock`): returns saved results from `data/ai-cache/`, using 0 real calls. This is the default during development.
- **Cache:** every real AI result is saved to disk with the hash of its input as the key. The same input never costs a second call.
- **Preloaded demo:** the demo chats and their saved AI results ship in the repo. "Reset demo" uses them, with 0 calls.
- **Timeout + retry + backup model:** a 30 s timeout. On 503, 429 or a timeout, retry once after a short wait, then try the backup model (`gemini-3.6-flash` first, then `gemini-3.8-flash`; each has its own 20/day).
- **Non-AI fallback:** if the AI fails or today's quota is used up, a simple parser takes over.
  - It matches menu aliases and numbers in each message, and `dates.js` handles the dates.
  - Ambiguous words like "brownies" become unclear rows.
  - It doesn't try to apply changes or cancellations. It flags a buyer with several messages as "check later messages".
  - Reminders fall back to a fixed template.
- **Daily call counter:** the server counts real calls per model per day and shows "AI calls left today: X/20" on the page. When it hits 0 the server stops calling and uses the fallback. Assumption: Google's day resets at midnight Pacific time (to verify). The count is our own estimate and may differ from Google's.
- **Input limits:** at most ~50 messages / 10,000 characters per paste, to keep the call small and cheap.
- **Accuracy:** measured with `scripts/accuracy.mjs` against known answers, and later against holdout chats the prompt was never tuned on (Section 7, step 8).

## 7. Build order (mock AI first)

1. Express skeleton, menu, demo chats, empty page. Load AG Grid 36.2.0 from the CDN.
2. AG Grid table showing orders; edit cells → `PUT /api/orders/:id`. Select editor (menu items) + date editor.
3. `orders.js` + `dates.js` pure logic (prices, totals, grouping per buyer, status mapping, day words) + tests.
4. Parse with **mock AI** + validation + unclear rows (`rowClassRules` highlight).
5. PayPal invoices: create + send per buyer, payer link + Copy-link renderer.
6. Status polling + Refresh button + status badge renderer + Reset demo.
7. Real Gemini call (one batched call, final order per buyer, JSON schema), cache.
8. **`scripts/accuracy.mjs`**: compares AI output with `data/expected-orders.json` and prints a score for each of buyers, items, quantities, dates, unclear flags and cancellations.
   - Mock mode by default; a real call only with `--real`.
   - Later: `data/holdout-chats.txt` (8-10 fictional chats, with expected answers, NOT used while tuning the prompt) tests the AI on messages it wasn't tuned for.
9. Timeout, retry, backup model, daily counter, "AI calls left".
10. Non-AI fallback parser + reminders (AI + template) + Copy.
11. Deploy to Render; end-to-end test on the hosted URL.
12. Edge-case tests, holdout accuracy run, pinned totals row + quick filter, design polish, README, video.

## 8. Cut list (we will NOT build)

- No WhatsApp/Instagram integration, and no logos of either anywhere.
- No seller login or accounts: one shared demo seller.
- No database: JSON files (Render free disk resets on restart → demo data reloads; invoice status always comes from PayPal).
- No webhooks (stretch goal only).
- No React or build step.
- No AG Grid Enterprise features (no row grouping).
- No live (real-money) PayPal: sandbox only.
- No sending emails; no PayPal `remind` endpoint (stretch goal only).
- No menu editor in the UI (edit `data/menu.json`).
- No images, voice notes or stickers in chats: text only.
- No inventory, delivery routing or multi-seller support.

## 9. Checkpoints (2 h/day, 7-9 PM MYT; ~34 h)

| Date | Goal | Done when |
|---|---|---|
| Mon 26 Oct | Step 1: Express skeleton, page, AG Grid from CDN | `npm start` shows a page with an empty grid at localhost |
| Tue 27 Oct | Step 2: AG Grid table + edits, select + date editors | Edits survive a page reload |
| Wed 28 Oct | Step 3: orders.js + dates.js + tests | `npm test` passes, incl. "brwnies" → unclear |
| Thu 29 Oct | Step 4: parse with mock AI + unclear rows | Demo chats → final orders with totals, unclear rows highlighted |
| Fri 30 Oct | Step 5: create + send invoices per buyer | Payer link appears, Copy works |
| Sat 31 Oct | Step 6: polling, badges, Refresh, Reset demo | Paid in sandbox → "Paid" badge in table |
| Sun 1 Nov | Step 7: real Gemini + cache | Real call once, second run uses cache |
| Mon 2 Nov | Step 8: accuracy.mjs + prompt tuning | Score printed; demo chats give 7 orders / RM 387.00 |
| Tue 3 Nov | Step 9: timeout, retry, backup, counter | "AI calls left" shown; quota 0 → fallback |
| Wed 4 Nov | Step 10: fallback parser + reminders | Works with `AI_MODE=off` |
| Thu 5 Nov | Step 11: deploy to Render | **Full flow works on the hosted URL** |
| Fri 6 Nov | Edge-case tests, holdout chats + accuracy, pinned totals + quick filter | Bad input / API failure don't crash; holdout score recorded |
| Sat 7 Nov | README (features, setup, testing logins) + **video script draft** + **save a Devpost draft** | Fresh clone runs from README alone; Devpost draft saved |
| Sun 8 Nov | **Feature freeze.** Design polish + buffer; stretch goals only if all green | All RULES.md build items ticked |
| Mon 9 Nov | **First: test paying with an English-language sandbox buyer account**, then record the video | Payment page in English; video under 3 min, no copyrighted music/logos |
| Tue 10 Nov | Video upload, GitHub public + MIT in About, Devpost details | All links work in a private window |
| Wed 11 Nov | "final check", then **submit (evening)** | Devpost shows Submitted |

Hard deadline: 13 Nov 2026, 4:00 AM MYT. Hosted demo and sandbox logins must keep working until 16 Dec 2026.
