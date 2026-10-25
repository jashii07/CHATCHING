# PLAN — Chat-to-Checkout

Status: DRAFT, waiting for Jasper's approval. No app code until approved.

## 1. Problem

Small home sellers in Malaysia take orders as messy chat messages in mixed English/Malay ("kak nak 2 brownies hantar sabtu"). They copy orders into Excel by hand, work out totals, then chase each buyer for payment one by one. It is slow and things get missed.

## 2. User

- **Main user:** a home seller (cakes, kuih, frozen food) with a small fixed menu and 10-50 chat orders a day. Not technical.
- **Judges:** log in as that seller (shared sandbox demo) and pay as a buyer with a sandbox personal account.

## 3. Flow

1. **Paste:** the seller pastes a day of chat messages into a text box.
2. **Read (AI, 1 call):** Gemini turns all messages into order rows: buyer, menu item, quantity, delivery date, plus an "unclear" flag with a reason. The AI never sets prices.
3. **Review:** rows appear in an AG Grid table. The code fills in the price from the menu and calculates the totals. The seller fixes unclear rows by editing cells.
4. **Invoice (no AI):** one click creates and sends one PayPal sandbox invoice per buyer, without emailing anyone. The table shows each buyer's payer link with a "Copy" button for pasting into the chat.
5. **Track:** status moves Draft → Sent → Paid. The page asks PayPal for the latest status (polling) when you click "Refresh status", and automatically every 20 s while the page is open.
6. **Remind (AI, 1 call):** for all unpaid buyers, Gemini drafts friendly reminders in one call. Each has a "Copy" button. If there is no AI, a template is used instead.

**Golden rule:** a payment never waits on the AI. Steps 4-5 make no AI calls.

## 4. Architecture A: one simple server

One Node 24 server (Express) serves the page and the API. The page is plain HTML + JavaScript, with AG Grid Community **36.2.0** loaded from jsDelivr. There is no build step. All keys stay on the server.

```
server.js                 Express app: routes + serves public/
src/paypal.js             token (cached in memory) + create/send/get invoice
src/ai.js                 Gemini: one batched call, timeout, retry, backup model, cache, mock mode
src/fallback.js           non-AI: simple rule-based parser + template reminders
src/orders.js             pure logic: prices from menu, totals, group rows by buyer, status mapping
src/store.js              saves orders + AI usage counter to data/*.json
public/index.html         the page
public/app.js             AG Grid table, buttons, polling
public/styles.css
data/menu.json            fixed menu (item -> price)
data/demo-chats.txt       sample mixed English/Malay chats
data/ai-cache/            saved AI results (key = hash of input); includes the preloaded demo
test/                     node:test tests (built into Node, no package)
scripts/                  smoke tests (PayPal order, invoice, Gemini)
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

## 5. Data shapes

**Menu** (`data/menu.json`), the only source of prices:
```json
{
  "currency": "MYR",
  "items": [
    { "id": "brownies", "name": "Brownies (box of 6)", "price": "15.00", "aliases": ["brownie", "brownies"] },
    { "id": "kek-batik", "name": "Kek batik (1 slab)", "price": "25.00", "aliases": ["kek batik", "batik"] }
  ]
}
```

**What the AI returns** (forced JSON format, no prices):
```json
{ "orders": [
  { "msg": 3, "buyer": "Kak Lina", "itemId": "brownies", "qty": 2,
    "deliveryDate": "2026-10-31", "unclear": false, "reason": "" }
] }
```
Our code checks every row: `itemId` must exist in the menu (otherwise the row is unclear), `qty` must be a whole number from 1 to 99, and the date must be valid. Anything bad becomes an unclear row; it is never dropped silently.

**Order row** (what the table shows):
```json
{ "id": "r7", "buyer": "Kak Lina", "buyerEmail": null,
  "itemId": "brownies", "itemName": "Brownies (box of 6)", "qty": 2,
  "unitPrice": "15.00", "lineTotal": "30.00",
  "deliveryDate": "2026-10-31", "unclear": false, "reason": "",
  "sourceMessage": "kak nak 2 brownies hantar sabtu",
  "invoiceId": null, "payerLink": null, "status": "Draft" }
```
Money is calculated in sen (whole numbers) to avoid rounding errors, then shown as "30.00".

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

- **One batched call** per action: all messages go in one prompt, and all reminders come out in one prompt. The JSON shape is forced with Gemini's response schema. The prompt includes the menu ids and today's date, so "sabtu" (Saturday) can become a real date.
- **Mock mode** (`AI_MODE=mock`): returns saved results from `data/ai-cache/`, using 0 real calls. This is the default during development.
- **Cache:** every real AI result is saved to disk with the hash of its input as the key. The same input never costs a second call.
- **Preloaded demo:** the demo chats and their saved AI results ship in the repo. "Reset demo" uses them, with 0 calls.
- **Timeout + retry + backup model:** a 30 s timeout. On 503, 429 or a timeout, retry once after a short wait, then try the backup model (`gemini-3.6-flash` first, then `gemini-3.8-flash`; each has its own 20/day).
- **Non-AI fallback:** if the AI fails or today's quota is used up, a simple rule-based parser matches menu aliases and numbers in each message. Anything it can't match becomes an unclear row for the seller to fix. Reminders fall back to a fixed template.
- **Daily call counter:** the server counts real calls per model per day and shows "AI calls left today: X/20" on the page. When it hits 0 the server stops calling and uses the fallback. Assumption: Google's day resets at midnight Pacific time (to verify). The count is our own estimate and may differ from Google's.
- **Input limits:** at most ~50 messages / 10,000 characters per paste, to keep the call small and cheap.

## 7. Build order (mock AI first)

1. Express skeleton, menu, demo chats, empty page.
2. AG Grid table showing orders; edit cells → `PUT /api/orders/:id`.
3. `orders.js` pure logic (prices, totals, grouping, status mapping) + tests.
4. Parse with **mock AI** + validation + unclear rows.
5. PayPal invoices: create + send per buyer, payer link + Copy.
6. Status polling + Refresh button + Reset demo.
7. Real Gemini call (one batched call, JSON schema), cache.
8. Timeout, retry, backup model, daily counter, "AI calls left".
9. Non-AI fallback parser + reminders (AI + template) + Copy.
10. Deploy to Render; end-to-end test on the hosted URL.
11. Tests for edge cases, design polish, README, video.

## 8. Cut list (we will NOT build)

- No WhatsApp/Instagram integration, and no logos of either anywhere.
- No seller login or accounts: one shared demo seller.
- No database: JSON files (Render free disk resets on restart → demo data reloads; invoice status always comes from PayPal).
- No webhooks (stretch goal only).
- No React or build step.
- No live (real-money) PayPal: sandbox only.
- No sending emails; no PayPal `remind` endpoint (stretch goal only).
- No menu editor in the UI (edit `data/menu.json`).
- No images, voice notes or stickers in chats: text only.
- No inventory, delivery routing or multi-seller support.

## 9. Checkpoints (2 h/day, 7-9 PM MYT; ~34 h)

| Date | Goal | Done when |
|---|---|---|
| Mon 26 Oct | Step 1: Express skeleton, menu.json, demo-chats.txt | `npm start` shows a page at localhost |
| Tue 27 Oct | Step 2: AG Grid table + edit rows | Edits survive a page reload |
| Wed 28 Oct | Step 3: orders.js + tests | `npm test` passes |
| Thu 29 Oct | Step 4: parse with mock AI + unclear rows | Demo chats → rows with totals |
| Fri 30 Oct | Step 5: create + send invoices | Payer link appears, Copy works |
| Sat 31 Oct | Step 6: polling, Refresh, Reset demo | Paid in sandbox → "Paid" in table |
| Sun 1 Nov | Step 7: real Gemini + cache | Real call once, second run uses cache |
| Mon 2 Nov | Step 8: timeout, retry, backup, counter | "AI calls left" shown; quota 0 → fallback |
| Tue 3 Nov | Step 9: fallback parser + reminders | Works with `AI_MODE=off` |
| Wed 4 Nov | Step 10: deploy to Render | **Full flow works on the hosted URL** |
| Thu 5 Nov | Edge-case tests + bug fixes | Bad input / API failure don't crash |
| Fri 6 Nov | Design polish | A first-time user gets through the flow unaided |
| Sat 7 Nov | README (features, setup, testing logins) | Fresh clone runs from README alone |
| Sun 8 Nov | **Feature freeze.** Buffer for anything late; stretch goals only if all green | All RULES.md build items ticked |
| Mon 9 Nov | Video script + recording | Under 3 min, no copyrighted music/logos |
| Tue 10 Nov | Video upload, GitHub public + MIT in About, Devpost draft | All links work in a private window |
| Wed 11 Nov | "final check", then **submit (evening)** | Devpost shows Submitted |

Hard deadline: 13 Nov 2026, 4:00 AM MYT. Hosted demo and sandbox logins must keep working until 16 Dec 2026.
