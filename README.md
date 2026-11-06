# ChatChing

ChatChing turns a day of messy chat orders into a clean order list and one PayPal invoice per buyer. It is built for small home sellers (cakes, kuih, frozen food) who take their orders in chats.

**Live app: https://chatching.onrender.com/**
The first load can take up to a minute while the free server wakes up.

## Try it in 1 minute

No login is needed. Each judge gets their own table, so nobody else can see or change your orders.

1. Click **Load demo**, then **Read orders**. The demo uses a saved AI reply, so it works even when the AI is busy.
2. Click **Send invoices**. Each buyer gets a real PayPal sandbox invoice. No emails are sent.
3. Click **Open invoice** on a sent row. This opens PayPal's own payment page for that invoice.
4. Click a buyer, then **Record payment** to record cash. The row shows **Paid (cash/bank)**.
5. Click **Kitchen list** to see how many of each item to make, per day.
6. Click **Pickup scan** and type or scan a buyer's invoice number: green means paid, amber means not paid yet.
7. Have a phone? Click **Open on my phone** and scan the QR with the phone's camera. The phone opens the same table, so you can try Pickup scan there on a buyer's QR. The QR works once, for 10 minutes.

**Reset demo** at the bottom clears your own table so you can start again. The free server also clears tables when it sleeps (after 15 minutes without visitors). If that happens, the page says so: click Load demo, then Read orders. Invoices already sent stay safe in PayPal.

## Judge test accounts

Two PayPal **sandbox** buyer accounts, made only for judges, for paying an invoice with PayPal. Sandbox accounts are practice accounts that hold only fake money, so these logins are not secrets like API keys. The official rules ask for test-account logins in the README; the same two logins are also in the Devpost submission's testing instructions.

| Account | Email | Password |
|---|---|---|
| Judge buyer 1 | `chatching.judge1@example.com` | `judge1@EXAMPLE` |
| Judge buyer 2 | `chatching.judge2@example.com` | `judge2@EXAMPLE` |

To pay: click a row's **Open invoice**, choose to log in to PayPal, use either login above, then click **Refresh status** in ChatChing. There are two accounts so that if one is locked or its password is changed, the other still works.

## What it does

1. **Paste:** the seller pastes a day of chat messages and checks the chat date.
2. **Read (AI):** Gemini reads all the messages and returns the final order per buyer. It applies later changes and cancellations, and marks anything unclear with a reason.
3. **Review:** the orders appear in a table. The code fills in prices from the menu. Clicking a buyer shows their own messages, highlighted, and lets the seller fix the order.
4. **Invoice (no AI):** one click creates and sends one PayPal invoice per buyer. Each buyer gets a payer link and a ready-to-send message to paste into the chat.
5. **Track:** the status moves from Not sent to Sent to Paid. The page asks PayPal every 20 seconds while it is open. The seller can record cash or bank payments, and check a buyer's invoice QR at pickup.

A payment never waits on the AI: sending invoices, recording payments and checking status make no AI calls.

## How PayPal is used

PayPal is the seller's record of every order and payment. ChatChing uses the PayPal **Invoicing API v2**, **sandbox only** (no real money).

| What | PayPal call |
|---|---|
| Sign in with the app's keys | `POST /v1/oauth2/token` (the token is kept in memory until it expires) |
| Create a draft invoice | `POST /v2/invoicing/invoices` |
| Send it, without emailing anyone | `POST /v2/invoicing/invoices/{id}/send` with `send_to_recipient: false`, `send_to_invoicer: false` |
| Get its status (Sent, Paid) | `GET /v2/invoicing/invoices/{id}` |
| Record a cash or bank-transfer payment | `POST /v2/invoicing/invoices/{id}/payments` |
| Make the pickup QR | `POST /v2/invoicing/invoices/{id}/generate-qr-code` |
| Find an invoice by its number | `POST /v2/invoicing/search-invoices` |

**The double-invoice guard.** A buyer must never be billed twice by accident:

1. The server skips any buyer that already has an invoice.
2. A per-buyer lock stops a double click from sending two.
3. Every invoice gets its own number (`CHATCHING-{batch}-{nn}`), and PayPal itself refuses a repeated number. If that happens, the server looks the invoice up by its number and uses it, but only if its items, quantities and prices match.
4. Reading the same buyers again later the same day marks them "already has an invoice". The seller must click **Send anyway** for a real second order.

## How AI is used

**Gemini reads the chats.** One call reads a whole day of messages and returns the final order per buyer: items, quantities, delivery date, pickup or delivery, cancelled or not, and a one-line note on what it did ("Changed from 2 to 3 boxes in message 4.").

**The golden rule: the AI never sets a price.** Prices come only from the seller's menu (`data/menu.json`). Money is counted in sen (whole cents), so totals are exact.

**Every reply is checked before it is used:**

- Each item must be on the menu, each quantity a whole number from 1 to 99, each date a real date.
- Each order must cite messages written by that buyer, so one buyer's message can't create or cancel someone else's order.
- If a buyer mentions a price that differs from the menu, the row turns amber: "Check: buyer mentioned RM 15.00, menu says RM 18.00." The invoice still uses the menu price.
- Anything unclear stays amber with its reason, and is never invoiced until the seller fixes it.

**When the AI is busy or used up:**

- One read has a 90 second budget: the main model (`gemini-3.6-flash`) gets up to 60 seconds, then a backup model (`gemini-3.8-flash`) gets the rest. There are never more than 3 calls.
- A daily counter shows "AI calls left". The free tier gives about 20 calls a day per model.
- **Read without AI** reads the chats with simple rules instead. It is careful on purpose: anything it is not sure of stays amber.
- Load demo always works, because it uses a saved reply (0 calls).

The ready-to-send messages, reminders and "Copy question" texts are code templates, not AI. AI calls are scarce, so the AI's one job is reading chats.

## The table: AG Grid Community

The order table is **AG Grid Community 36.2.0** (free version, no Enterprise features), loaded from a CDN with a pinned version and integrity hash. It uses pagination, custom cell renderers (buyer avatar, item chips, status badges, Copy link), row highlighting for amber and cancelled rows, a pinned totals row, the quick-filter search box, an external filter for "Needs check", CSV export, and a green flash on the status cell when an invoice turns Paid.

## Accuracy

How well the AI reads chats, scored item by item: buyers, cancellations, items, quantities, dates, unclear flags, pickup or delivery, and prices. Full details are in [docs/accuracy.md](docs/accuracy.md).

| Test set | What it is | Score |
|---|---|---|
| Demo chats | Written by me. The saved reply is checked on every `npm run check`. | 74/74 |
| Set A "cafe-usd" | Real cafe orders, reformatted by AI; names added by me | 73/74 |
| Set B "daily-grind" | An AI-written third-party test set | 74/74 |

- **Read honestly:** the demo score shows the pipeline works, not how well the AI reads other sellers, because I wrote those chats. Sets A and B are one live run each (1 Nov 2026, `gemini-3.6-flash`). The prompt was not tuned on them, and it won't be.
- **The one miss (Set A):** a buyer asked for oat milk, which is not on that menu. The AI put it in the note instead of flagging it, so the order would show as ready to invoice. The menu price would still be charged, but the seller would not be warned.
- Neither set had delivery dates or "pickup" in the chats, so those two scores were easy.

## Security and safety

- **Per-visitor tables:** each browser gets its own table through a cookie, with no login. One visitor can't see or reset another's orders. A phone joins a table only through a one-time QR (10 minutes, works once).
- **Rate limits** on reading chats, sending invoices, recording payments, status checks, pickup checks and phone pairing, plus the daily AI counter. Over a limit, the page shows friendly words instead of an error.
- **Security headers** on every reply, including a Content-Security-Policy that only allows the app's own scripts and the two pinned CDN files.
- **CSRF check:** a change sent from another website is refused (403).
- **No keys in the repo:** keys live in `.env` (git-ignored) or Render's settings. `npm run check` fails if `.env` was ever committed.
- **The 1 Nov review:** a full bug hunt and security audit (QA Bug Hunter + finecomb) found 18 issues: 0 critical, 2 high, 7 medium, 9 low. Each fix was written test-first, in two fix sessions on 1 and 2 Nov. One low item, a rare crash of Node's test runner on Windows, is worked around (the file reruns once), not fixed.

## Architecture

One small Node server. No database, no build step.

```
Browser (public/: HTML + JS + AG Grid)
   |
Express server (server.js, src/app.js)
   |-- src/ai.js, src/gemini.js     Gemini call, time budget, backup model, cache
   |-- src/validate.js              checks every AI reply
   |-- src/fallback-parse.js        Read without AI
   |-- src/orders.js, src/money.js  prices from the menu, totals in sen
   |-- src/paypal.js, src/invoices.js   PayPal Invoicing API + double-invoice guard
   |-- src/store.js, src/visitors.js    one JSON file per visitor's table
   |-- src/security.js, src/rate-limit.js
```

## Run it locally

You need **Node 24** and PayPal sandbox keys from the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).

```
git clone https://github.com/jashii07/CHATCHING.git
cd CHATCHING
npm ci
```

Copy `.env.example` to `.env`, then fill in your own sandbox keys (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`). `GEMINI_API_KEY` is only needed with `AI_MODE=real`. `AI_MODE=mock` (the default) reads the demo from its saved reply, with no AI calls.

```
npm start
```

Open http://localhost:3000. Without keys the app still starts and the demo still reads; only Send invoices says PayPal is not configured.

```
npm run check
```

This runs every test, scores the saved demo reply, and checks that `.env` is not in git.

## Known limitations

- **The free server sleeps** after 15 minutes without visitors, and every sleep, restart or deploy clears every table. Invoices stay safe in PayPal.
- **The free AI tier is small and often busy:** about 20 calls a day per model, shared by all visitors. A busy reply ("high demand") was seen in every real session.
- **The oat-milk miss:** an add-on that is not on the menu can slip through as a clear order (see Accuracy).
- **English chats only,** with a few Malay words in Read without AI.
- **No undo** for a recorded cash payment.
- **Pickup scan and Open on my phone** were tested mostly in test browsers with a fake camera, not across many real phones.
- **No menu editor:** the menu is edited in `data/menu.json`.
- The full list, with the reasons, is in [DECISIONS.md](DECISIONS.md) under "Known weaknesses".

## What's next

- A menu editor in the app
- Voice notes and chat screenshots as input
- Daily stock limits ("only 10 boxes on Saturday")
- More payment methods
- Order history across days
- Simple analytics (best sellers, busiest days)
- More languages

## How it was built

I am a first-year student. I directed this project: I chose the idea, approved the plan, made the big decisions, and checked the app in the browser. The code was written with Claude Code, an AI coding assistant, working from my plan and instructions. Smaller technical choices that Claude made are marked "Claude's choice" in the log.

Every decision, with my reason and the alternatives, is logged in [DECISIONS.md](DECISIONS.md). The prompts I gave and what happened are in [PROMPT_LOG.md](PROMPT_LOG.md). The plan is in [PLAN.md](PLAN.md).

## Licence

MIT. See [LICENSE](LICENSE).
