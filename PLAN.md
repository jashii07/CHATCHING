# PLAN — ChatChing

Status: APPROVED 2026-10-25 (with changes). Standout features added 2026-10-25 (Sections 10-11). Build starts Mon 26 Oct, 7 PM MYT.

## 1. Problem

Small home sellers take orders as messy chat messages in English ("can i order 2 boxes of classic brownies, deliver on saturday?"). The demo seller is in Malaysia, so prices are in RM. They copy orders into Excel by hand, work out totals, then chase each buyer for payment one by one. It is slow and things get missed.

## 2. User

- **Main user:** a home seller (cakes, kuih, frozen food) with a small fixed menu and 10-50 chat orders a day. Not technical.
- **Judges:** log in as that seller (shared sandbox demo) and pay as a buyer with a sandbox personal account.

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
src/store.js              saves orders + AI usage counter to data/*.json
public/index.html         the page
public/app.js             AG Grid table, buyer panel, buttons, polling
public/styles.css
data/menu.json            fixed menu (item -> price, aliases)
data/demo-chats.txt       fictional English chats
data/expected-orders.json correct answers for demo-chats.txt
data/holdout-chats.txt    (by 1 Nov) real, anonymised chats from a seller, never used while tuning the prompt
data/holdout-expected.json (by 1 Nov) correct answers for holdout-chats.txt, written by Jasper
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
| `POST /api/parse` | chat text + chat date → order rows (replaces the current rows) | 1 call, or cache/fallback |
| `PUT /api/orders/:id` | save one edited row | No |
| `POST /api/invoices` | create + send one invoice per buyer that has no invoice yet (double-invoice guard, #3c) | **Never** |
| `POST /api/invoices/refresh` | ask PayPal for the status of every open invoice | No |
| `POST /api/invoices/:id/payment` | record a cash / bank-transfer payment in PayPal (#3a) | **Never** |
| `GET /api/invoices/:id/qr` | pickup QR code image from PayPal (#3b) | **Never** |
| `POST /api/messages` | ready-to-send message per invoiced buyer (#2) | 1 call, or template |
| `POST /api/reminders` | reminders for all unpaid buyers, same design as messages | 1 call, or template |
| `POST /api/reset` | reload the demo orders + saved AI results | **0 calls** |

### AG Grid showcase (Community features only, no Enterprise)

| Feature | Used for |
|---|---|
| Select cell editor (`agSelectCellEditor`) | pick a menu item; the price updates from the menu |
| Date cell editor | fix a delivery date |
| Custom cell renderer: status badge | Draft / Sent / Paid / Paid (cash) / Cancelled in colours |
| `rowClassRules` | highlight unclear rows (and grey out cancelled ones) |
| Custom cell renderer: Copy-link button | copy the payer link for the chat |
| Pinned bottom row | totals: number of orders and RM total |
| Quick filter search box | find a buyer or item fast |
| CSV export (`exportDataAsCsv`) | "Export CSV (opens in Excel)" button (#4) |
| Cell flashing (`flashCells`) | the status cell flashes green when it turns Paid (#4) |
| Row click event | opens the buyer panel (#1) |

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

**Accuracy check:** `data/expected-orders.json` holds the correct answers for the demo chats: 7 clear orders worth RM 387.00, 1 unclear, 1 cancelled and 1 non-order, plus the demo's fixed `chatDate` (2026-10-28). Its orders use the same field names as the AI output above, so `scripts/accuracy.mjs` compares the parser's output against it directly, with no name translation (see Section 7).

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

- **One batched call** per action. All messages go in one prompt, and the final order per buyer comes out, each with a note. Messages and reminders are also one call each (Section 10, #2). The JSON shape is forced with Gemini's response schema. The prompt includes the menu ids and aliases, and the "plain brownies = unclear" rule.
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
- **Mock mode** (`AI_MODE=mock`): returns saved results from `data/ai-cache/`, using 0 real calls. This is the default during development. The demo's parse result is Gemini's real reply from the AI reality check (Step 3b), saved unchanged, so mock mode behaves like the real AI.
- **Cache:** every real AI result is saved to disk with the hash of its input as the key. The same input never costs a second call.
- **Preloaded demo:** the demo chats and their saved AI results (parse, messages, reminders) ship in the repo. "Reset demo" uses them, with 0 calls.
- **Timeout + retry + backup model:** a 30 s timeout. On 503, 429 or a timeout, retry once after a short wait, then try the backup model (`gemini-3.6-flash` first, then `gemini-3.8-flash`; each has its own 20/day).
- **Non-AI fallback:** if the AI fails or today's quota is used up, a simple parser takes over.
  - It matches menu aliases and numbers in each message, and `dates.js` handles the dates.
  - Ambiguous words like "brownies" become unclear rows.
  - It doesn't try to apply changes or cancellations. It flags a buyer with several messages as "check later messages".
  - Messages and reminders fall back to the English templates.
- **Daily call counter:** the server counts real calls per model per day and shows "AI calls left today: X/20" on the page. When it hits 0 the server stops calling and uses the fallback. Assumption: Google's day resets at midnight Pacific time (to verify). The count is our own estimate and may differ from Google's.
- **Input limits:** at most ~50 messages / 10,000 characters per paste, to keep the call small and cheap.
- **Accuracy:** measured with `scripts/accuracy.mjs` against known answers, and once against holdout chats the prompt was never tuned on (Section 10, #5).
- **Privacy:** the Gemini free tier may use inputs to improve Google's products, and "human reviewers may read" them. So only fictional or anonymised chats are sent (Section 10, #5).

## 7. Build order (mock AI first)

Order in time (dates in Section 9): 1 → 3 → 2 → 3b → 4 → 5 → … Step 3 (pure logic) runs before Step 2, so the grid is built after the UI spec (Section 12) and can use the price logic. Every UI step follows Section 12.

1. ✅ (done Sun 25 Oct) Express skeleton, menu, demo chats, empty page. Load AG Grid 36.2.0 from the CDN, and check that CSV export, cell flashing and the quick filter are in the bundle.
2. AG Grid table showing orders; edit cells → `PUT /api/orders/:id`. Select editor (menu items) + date editor.
3. ✅ (done Mon 26 Oct) `money.js` + `orders.js` + `dates.js` pure logic (prices, totals, grouping per buyer, status mapping, day words) + tests.

**3b. AI reality check (spike), Wed 28 Oct.** Why: the AI is the least-proven part. We proved PayPal on day 1; now we prove the AI before building on it.
- `scripts/spike-parse.mjs` makes ONE real `gemini-3.6-flash` call on `data/demo-chats.txt`, with the menu (ids, aliases, the "plain brownies = unclear" rule), chat date 2026-10-28 (each message gets its full date from `dates.js`) and the planned JSON schema (Section 5).
- It prints how long the call took, and compares the reply with `data/expected-orders.json`: buyers, items, qty, dates, unclear and cancelled (for example "items 8/9").
- It uses a long timeout (90 s) to measure the real time, so we can check the app's planned 30 s timeout (Section 6) against it.
- **Max 3 real calls that day** (of the 20/day free quota): the script counts its own calls in `tmp/` and refuses a 4th. Run it with `node --env-file=.env` (it never opens .env). The demo chats are fictional, so they're safe for the free tier.
- **The real reply is saved unchanged** as `data/ai-cache/demo-parse.json`. Step 4's mock mode returns it, so the mock data matches what Gemini really returns, mistakes included.
- The prompt, schema and comparison code are reused in Step 7 (the real call inside the app) and Step 8 (`accuracy.mjs`).

4. Parse with **mock AI** (results already include `note` and `fulfilment`) + validation + unclear rows (`rowClassRules` highlight).
5. PayPal invoices: create + send per buyer, payer link + Copy-link renderer, **double-invoice guard (#3c)**.
   - Missing PayPal keys → the clear message "PayPal is not configured", sent on purpose (the error handler hides every 5xx message), plus a test.
6. Status polling + Refresh button + status badges + Reset demo. **Paid flash + CSV export (#4)**, pinned totals row + quick filter, **record cash / bank (#3a)**.
7. Real Gemini call (one batched call, final order per buyer, JSON schema), cache. **Buyer panel with note + highlighted source messages (#1)**, **pickup QR in the panel (#3b)**.
8. **`scripts/accuracy.mjs`**: compares AI output with `data/expected-orders.json` and prints a score for each of buyers, items, quantities, dates, unclear flags and cancellations.
   - Mock mode by default; a real call only with `--real`.
   - `--holdout` runs it on the holdout chats (only once, on 7 Nov).
9. Timeout, retry, backup model, daily counter, "AI calls left".
10. **Ready-to-send messages + reminders (#2)**: one batched call each, placeholders, checks, English templates, Copy.
11. Deploy to Render; end-to-end test on the hosted URL.
12. **User test with a real seller (#5)**; non-AI fallback parser.
13. Edge-case tests, **holdout accuracy run (#5)**, README, video script, Devpost draft.
14. Feature freeze: fixes from the user test, design polish, stretch only if all green; video; submit.

## 8. Cut list (we will NOT build)

- No WhatsApp/Instagram integration, and no logos of either anywhere.
- No seller login or accounts: one shared demo seller.
- No database: JSON files (Render free disk resets on restart → demo data reloads; invoice status always comes from PayPal).
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
| Tue 27 Oct (2 h) | Step 2: AG Grid table + edits, select + date editors, **following the UI spec (Section 12)**. **You: fill in Section 12 from your sketch before this session** | Edits survive a page reload; the page matches Section 12 |
| Wed 28 Oct (2 h) | **Step 3b: AI reality check** (the day freed by finishing Step 1 early): one real gemini-3.6-flash call, **max 3 that day** | Call time + comparison with expected-orders.json printed and logged in DECISIONS.md; the real reply saved as the mock-AI data |
| Thu 29 Oct (2 h) | Step 4: parse with mock AI (= Wednesday's real Gemini reply) + unclear rows | Demo chats → final orders with totals, notes, unclear rows highlighted |
| Fri 30 Oct (2 h) | Step 5: create + send invoices per buyer + double-invoice guard. **You: draft the video storyboard (Section 13)** | Payer link + Copy work; double-click still gives one invoice per buyer; storyboard drafted |
| Sat 31 Oct (6 h) | Step 6: polling, badges, Refresh, Reset demo; Paid flash + CSV export; pinned totals + quick filter; record cash/bank. **Buffer hour: FIRST DEPLOY to Render of whatever exists (walking skeleton)**, and check Render's free-tier rules (sleep after inactivity, monthly hours, whether it asks for a card; **if it asks for a card, stop and ask Jasper**) → note them in DECISIONS.md | Paid in sandbox → cell flashes green; cash → "Paid (cash)"; CSV opens in Excel; **the app loads from a Render URL** |
| Sun 1 Nov (5 h) | Step 7: real Gemini + cache; buyer panel (note + highlighted messages); pickup QR | Real call once, cached after; clicking Arif shows his 2 messages + a QR. **You: holdout chats + expected answers saved** |
| Mon 2 Nov (2 h) | Step 8: accuracy.mjs + prompt tuning | Score printed; demo chats give 7 orders / RM 387.00 |
| Tue 3 Nov (2 h) | Step 9: timeout, retry, backup, counter | "AI calls left" shown; quota 0 → friendly "AI busy" message |
| Wed 4 Nov (2 h) | Step 10: ready-to-send messages + reminders | Every invoiced buyer has a copyable message with the real total + link |
| Thu 5 Nov (2 h) | Step 11: deploy to Render | **Full flow works on the hosted URL** |
| Fri 6 Nov (2 h) | 7 PM: **user test with your friend (10 min)** → LEARNING.md; then Step 12: non-AI fallback parser | Test notes saved; app works with `AI_MODE=off` |
| Sat 7 Nov (5 h) | Edge-case tests; **holdout accuracy run (once)**; README (features, setup, testing logins = the 2 judge accounts); **video script draft** (from the Section 13 storyboard); **save a Devpost draft**. **You: create 2 sandbox buyer accounts just for judges**, in English so judges can read the payment page (if one gets locked or its password changed, judges use the other) | Holdout score recorded as-is; fresh clone runs from README alone; Devpost draft saved; both judge logins work |
| Sun 8 Nov (5 h) | **Feature freeze.** Fixes from the user test, design polish, buffer; stretch only if all green | All RULES.md build items ticked |
| Mon 9 Nov (2 h) | **First: test paying with an English-language sandbox buyer account** (one of the judge accounts), then record the video | Payment page in English; video under 3 min, no copyrighted music/logos |
| Tue 10 Nov (2 h) | Video upload, GitHub public + MIT in About, Devpost details | All links work in a private window |
| Wed 11 Nov (2 h) | "final check", then **submit (evening)** | Devpost shows Submitted |

Hard deadline: 13 Nov 2026, 4:00 AM MYT. Hosted demo and sandbox logins must keep working until 16 Dec 2026.

**Tightest part:** Mon 2 – Fri 6 Nov has ~11 h of work in 10 h, and Fri 6 Nov has two jobs. If it slips, it spills into the buffer hour on 7 or 8 Nov. If that isn't enough, cut in this order: 3 first, then 2, then 1, keeping 5 and 4.

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
- **b.** Shown only when `fulfilment` is `"pickup"` (Arif in the demo). A "Pickup QR" button in the buyer panel shows the code to scan or print. The server reads the Base64 PNG out of the multipart reply.
- **c.** Three layers:
  1. The server skips buyers that already have an invoice.
  2. A per-buyer "in progress" lock, with the button disabled while sending, so a double-click can't create two.
  3. Every invoice gets `invoice_number` = `CHATCHING-{batch}-{nn}`, e.g. `CHATCHING-K3F9Q2ZA-07`. The batch is 8 characters, so the number is 21 characters, within PayPal's max of 25. The batch changes on every parse and every Reset demo, so PayPal itself rejects a repeat. On `DUPLICATE_INVOICE_NUMBER`, the row shows "Already invoiced, click Refresh".

### 4. AG Grid extras (both Community, checked in AG Grid's module list)
- **"Export CSV (opens in Excel)"** → `api.exportDataAsCsv()` (CsvExportModule, Community).
  - Real `.xlsx` export (`ExcelExportModule`) is **Enterprise**, so we don't use it.
  - Risk: Excel can garble emoji and accented names in a CSV. If it does, add a byte-order mark (BOM), a hidden marker that tells Excel the file is UTF-8.
- **The status cell flashes green when it turns Paid.** Polling notices the change, then calls `api.flashCells({ rowNodes, columns: ["invoiceStatus"] })` (HighlightChangesModule, Community).
  - The colour comes from the CSS variable `--ag-value-change-value-highlight-background-color`.
  - Only the change to Paid flashes, not every change.

### 5. Real-seller proof
- **Holdout chats:** `data/holdout-chats.txt` holds your friend's real messages (names and phone numbers changed, with permission). `data/holdout-expected.json` holds the answers you write yourself.
  - **You save both by Sun 1 Nov**, before prompt tuning (Mon 2 Nov). We don't open them while tuning.
  - `accuracy.mjs --holdout --real` runs **once**, on Sat 7 Nov. The score is recorded as-is, even if it's low.
  - **Privacy:** Google's free-tier terms say "Do not submit sensitive, confidential, or personal information" and that "human reviewers may read" inputs. So also remove addresses, places and anything personal. Your friend's permission must cover a **public GitHub repo** and **Google's free tier**.
  - `data/README.md` gets a line saying the holdout chats are real but anonymised. Everything else stays fictional.
- **User test:** Fri 6 Nov, 10 minutes, your friend on the hosted app.
  - Give 3 tasks: paste a day of chats → fix the unclear rows → send invoices and copy a message.
  - Don't help. Note what confused them in LEARNING.md. Fixes go into Sun 8 Nov.

## 11. Stretch list (only after Sections 7 and 10 work)

In suggested order:
1. **Mask phone numbers before AI calls.** Cheap, and fits the free-tier privacy rule.
2. **Judge-first screen:** a 3-step guide, a "Load demo" button and money summary cards (orders, invoiced, paid). It helps the Design and Presentation scores.
3. **Quick-fix buttons for unclear rows,** e.g. "Classic" / "Cheese" for "which brownies?".
4. **README trust signals** + a GitHub Actions test badge.
5. **Screenshot input:** a picture of the seller's own plain chat text only (no app logos). It costs AI quota.
6. **Already planned as stretch:**
   - PayPal `remind` endpoint.
   - Webhooks.
   - Finding the existing invoice after `DUPLICATE_INVOICE_NUMBER`, via invoice search.

## 12. UI spec (filled in Mon 26 Oct)

**Every UI step must follow this spec** (Steps 2, 4, 5, 6, 7 and 10), **and must be checked at laptop, iPad and phone widths** (1280 px, 820 px and 375 px). If a step needs something the spec doesn't cover, Claude asks before inventing it.

Goal (Jasper): clean but informative, warm, and working on every type of device.

### Colours: few, each with one job

| Colour | Hex | Job (only this) |
|---|---|---|
| Cream | `#FBF7F0` | page background |
| White | `#FFFFFF` | cards and the table |
| Dark navy | `#1F2A44` | all text |
| Muted grey | `#5B6270` | secondary text, cancelled rows *(Claude's addition: a grey, not a colour; 6.1:1 on white)* |
| PayPal-ish blue | `#1D4E9E` | **clickable only**: main buttons (white text), links, Copy buttons, focus ring |
| Warm amber | `#E0A030` | **"check this" only**: unclear rows and warnings |
| Warm grey | `#E8E1D5` | card and table borders (decorative) |
| Darker warm grey | `#8C8270` | borders of text boxes and inputs *(Claude's addition, see contrast below)* |

**Colour rule:** blue = clickable, amber = check this, green = money arrived. Nothing else gets colour.

**Status badges** (soft tints, navy text, rounded pill):

| Badge | Background | Text |
|---|---|---|
| Draft | light grey `#EEF0F3` | navy |
| Sent | light blue `#DCE8F7` | navy |
| Part paid | light blue `#DCE8F7` | navy |
| Paid / Paid (cash/bank) | light green `#DCF2E3` | navy |
| Cancelled/Refunded | grey `#ECEDEF` | muted grey `#5B6270`, strikethrough |

Badge colours for "Part paid" and "Paid (cash/bank)" are Claude's choice (the spec named 4 badges; the app has 6 states). The "Paid" cell flash uses the same light green.

**Unclear rows and warnings:** a light amber tint `#FCEFD6` behind the row, plus a 4 px amber `#E0A030` stripe on its left edge, **plus the words "Check: \<reason\>"** in navy. The words matter because the amber stripe alone is too faint to rely on (see contrast).

**Contrast check (WCAG AA: 4.5:1 for normal text, 3:1 for large text and input borders), measured 2026-10-26:**

| Pair | Ratio | Result |
|---|---|---|
| navy on cream / on white | 13.35 / 14.26 | ✅ |
| white on the blue button; blue link on white / on cream | 7.97; 7.97 / 7.46 | ✅ |
| navy on the badge tints (Draft, Sent, Paid) | 12.49, 11.49, 12.12 | ✅ |
| muted grey on the Cancelled tint / on white | 5.23 / 6.13 | ✅ |
| navy on the amber tint `#FCEFD6` | 12.53 | ✅ |
| **amber `#E0A030` as text** on white | 2.27 | ❌ so amber is **never used for text**, only tints and stripes |
| **warm grey `#E8E1D5` border** on white | 1.30 | ❌ for inputs, so inputs use `#8C8270` (3.79 on white, 3.55 on cream). OK for decorative card borders |

### Type
- System font stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- Body 16 px; table 15 px.
- Money is right-aligned with tabular numbers (`font-variant-numeric: tabular-nums`), so the digits line up.

### Layout

| Width | Layout |
|---|---|
| **Laptop** (≥ 1024 px) | Chats on the left, table on the right. Clicking a row slides the buyer panel in from the right. |
| **iPad** (641–1023 px) | The chat box sits at the top and can be collapsed. The table is full width. The buyer panel slides in from the right. |
| **Phone** (≤ 640 px) | Everything stacked. The table shows only **Buyer, Item, Total, Status**. Tapping a row opens the buyer panel **full screen**. A sticky bottom bar shows the total and a "Send invoices" button (it replaces the pinned totals row on phones). |

- Tap targets are at least 44 × 44 px on every device (buttons, Copy, row taps, the panel's close button).
- The breakpoints (640 / 1024 px) are Claude's choice. A landscape iPad (1180 px wide) gets the laptop layout.
- Spacing is kept from Step 1: 16 px side gutters and card padding, 8 px rounded corners.

### 3-step guide
- At the top of the page: **1 Paste → 2 Review → 3 Get paid**. The current step is highlighted: a filled navy circle and bold text. The other steps are muted grey. Not blue, because the steps aren't buttons.
- The current step is worked out by Claude's suggested rule: no rows yet → 1; rows but no invoices → 2; any invoice sent → 3.

### AG Grid
- Quartz theme, tuned with `themeQuartz.withParams({...})` using the colours above: background white, text navy, accent blue, borders warm grey, header background cream, font = the system stack, font size 15 px, hover/selected rows a light warm tint (not blue, because blue means clickable).
- Check the exact `withParams` names against the 36.2.0 docs in Step 2 before using them.

### Errors (decided Mon 26 Oct)
- Errors (for example "PayPal is not working right now") use the **amber tint `#FCEFD6` + the word "Error:"** in navy, so the colour rule stays: amber = check this. No red anywhere. Jasper's reason: "because its clearer".

## 13. Video storyboard (placeholder: you draft it by Fri 30 Oct)

Drafted early so we build the moments the video needs. Rules (RULES.md): public on YouTube, **under 3 minutes**, shows the app working end to end, no copyrighted music, no third-party trademarks (no WhatsApp/Instagram logos). The words come later: video script on Sat 7 Nov, recording on Mon 9 Nov.

| # | Time | On screen | What I say | Moment the app must have | Built in step |
|---|---|---|---|---|---|
| 1 | _TODO_ | _TODO_ | _TODO_ | _TODO_ | _TODO_ |

Moments the plan already has (ideas, not decisions): messy chats → a clean table with totals; fixing the "which brownies?" unclear row; one click → an invoice per buyer; copying a payer link and a ready-to-send message; paying in sandbox → the status cell flashes Paid; recording cash; the pickup QR; the CSV opening in Excel; the buyer panel showing the AI's note and source messages.
