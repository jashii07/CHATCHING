# Devpost draft — ChatChing

Rule for this page: only claims I can prove. No invented statistics. Every number comes from my own tests (see `docs/accuracy.md`, `npm run check`) or from a source with a link.

## Elevator pitch (on Devpost, max 200 chars)

Business happens in the chat. ChatChing's AI turns a day of messy chats into a clean order list; one click sends every buyer a PayPal pay link. Just chat, confirm, and get paid.

(177 characters)

## Inspiration

I'm a first-year student at UTP in Malaysia. A friend of mine takes orders by chat and copies every order into Excel by hand: who ordered what, who changed their mind, who has paid. In my dorm, sellers of bubur ayam, shawarma and matcha take orders through group chats and Google Forms. At the end of the day someone scrolls back through dozens of messages to work out the final orders and chase payments. I wanted to turn a messy chat into clean PayPal invoices in one click, without ever letting an AI decide what someone pays.

## What it does

For many online sellers, business happens in the chat — but managing orders and collecting payments is still a headache. ChatChing turns a full day of messy conversations into a clean, reviewable order list using AI. With one click, sellers can generate PayPal payment links for every buyer. No more digging through endless chats, manually tracking orders, or chasing payments one by one. Just chat, confirm, and get paid.

In more detail:

- **Read orders:** the seller pastes a day of chats. Gemini returns the final order per buyer, with later changes and cancellations applied, and a one-line note on what it did.
- **Review:** the orders appear in a table. Prices come from the seller's menu, never from the AI. Anything unclear is amber with its reason, and clicking a buyer shows their own messages highlighted.
- **Send invoices:** one click creates and sends a PayPal invoice for each buyer, with a payer link and a ready-to-send message to paste into the chat.
- **Get paid:** the status updates from PayPal (Sent, Paid). The seller can record cash or bank payments in PayPal, so PayPal holds the full record.
- **Make and hand over:** a Kitchen list shows how many of each item to make per day. At pickup, the seller scans the buyer's PayPal QR on their phone and sees green (paid) or amber (not paid yet).

## How we built it

- **One small Node.js server** (Express) with plain HTML and JavaScript. No database and no build step, so it is simple to run and to host.
- **PayPal Invoicing API v2, sandbox:** create, send (without emailing anyone), get status, record payment, generate the QR, and search by invoice number.
- **Google Gemini** (`gemini-3.6-flash`, with `gemini-3.8-flash` as a backup): one call reads all the chats and returns JSON in a fixed shape. The app's code checks every reply before it is used.
- **AG Grid Community** for the order table: pagination, custom cells, highlighted rows, a totals row, search, CSV export and a green flash when an invoice turns Paid.
- **Hosted on Render's free plan.** Each visitor gets their own table through a cookie, with no login.
- **Tested as I went:** 654 automated tests, browser checks at phone and laptop sizes, and a check of the whole flow on the live site with real sandbox invoices.

I am a first-year student. I directed the project and made the decisions; the code was written with Claude Code. Every decision and prompt is logged in the repo (`DECISIONS.md`, `PROMPT_LOG.md`).

## Challenges we ran into

- **The free AI tier is busy.** Gemini answered "high demand" at least once in every real session I ran, from 25 Oct to 1 Nov. So the app has a time budget (90 seconds per read), a backup model, a daily counter, a careful "Read without AI" mode, and a saved demo reply that always works.
- **Never bill a buyer twice.** PayPal's `PayPal-Request-Id` header didn't stop a repeat for invoices in my sandbox test. So every invoice gets its own number, which PayPal refuses to repeat, plus guards in the app's own code. A review later found a second way to bill twice (reading the same chats again in a new batch), and I closed that too.
- **The AI must never set a price.** The AI only picks items and quantities from the menu. Prices come from the menu, and money is counted in whole cents so totals are exact.
- **The free server forgets.** Render's free plan clears its disk on every sleep or restart. Invoices are safe because they live in PayPal, and the page explains what happened when a table is cleared.
- **Real browsers find what tests miss.** My first security policy passed every unit test, then blocked the table's icons in Chrome. Only a real browser showed it.

## Accomplishments that we're proud of

- **The AI never touches money.** Prices come from the menu, every AI reply is checked, and unclear orders are never invoiced until the seller fixes them.
- **Honest accuracy results**, each run once, with no prompt tuning on the test sets:
  - Demo chats (written by me): 74/74.
  - Real cafe orders, reformatted by AI, names added by me: 73/74. The one miss: oat milk, which is not on the menu, went into the note instead of being flagged.
  - An AI-written third-party test set: 74/74.
- **PayPal is central:** invoices, payments, status and the pickup QR all go through the PayPal Invoicing API.
- **A full review before submitting:** a bug hunt and security audit found 18 issues (none critical). Each was fixed with a test written first; one rare Windows test-runner crash is worked around, not fixed.
- **It works end to end on the live site,** with real sandbox invoices.

## What we learned

- **Directing AI means deciding the limits up front.** Twice I wished I had: which branch to push when "push" and "don't deploy yet" were both in one request, and a time limit on a low-priority bug before the hunt for its cause began, not half-way through. Both are in my prompt log.
- **One good number isn't proof.** A fix that looked perfect in 2,000 runs still failed 3 times in 100 full runs. I learned to test the whole thing, more than once.
- **Label results honestly.** A perfect score on chats I wrote myself says the pipeline works, not that the AI reads every seller well. Saying which is which makes the results more believable.
- **Check the docs against reality.** PayPal's docs say a cash payment makes an invoice `PAID`; the sandbox really says `MARKED_AS_PAID`. Testing on the real sandbox early saved me from building on the wrong word.

## What's next for ChatChing

- A menu editor in the app
- Voice notes as input
- Chat screenshots as input
- Daily stock limits ("only 10 boxes on Saturday")
- More payment methods
- Order history across days
- Analytics (best sellers, busiest days)
- More languages

## Built with

Devpost tags (15 of the 25 allowed), each checked against package.json and the code on 3 Nov:

javascript, node.js, express, html5, css3, paypal, paypal-invoicing-api, google-gemini, ag-grid, render, playwright, jsqr, qrcode-generator, lucide, claude-code

- express 5.3.0 and qrcode-generator 2.0.4 are in `dependencies`; jsqr 1.4.0 and playwright-core 1.64.0 (the browser checks) in `devDependencies`.
- AG Grid Community 36.2.0 and Lucide 1.55.0 load from jsDelivr, pinned in `public/index.html`.
- Gemini (`src/gemini.js`) and PayPal Invoicing v2 are called over their REST APIs, with no SDK.
- Hosted on Render (free plan). Built with Claude Code.

## Try it out (links)

- https://chatching.onrender.com/
- https://github.com/jashii07/CHATCHING (works once the repo is public, Tue 10 Nov)

## Gallery shot list

6 images, 1500 x 1000 px (3:2), PNG, each well under Devpost's 5 MB limit. Made by `npm run gallery` (Playwright, a LOCAL server and the FAKE PayPal: no real calls, no AI calls) into `tmp/gallery/` (git-ignored). Run it on Mon 9 Nov, after the design polish, and look at every image before uploading.

1. **The table after Read orders**: the demo chats read into one order per buyer, with the summary cards.
2. **An amber Check row with Copy question**: the table filtered to the rows to check, Priya's "which brownies?" question copied.
3. **Send invoices with the progress bar**: caught at "Sending invoice 3 of 7...".
4. **A Paid row in green**: Hafiz has paid, and the Paid card is green.
5. **The Kitchen list**: how many of each item to make, per day.
6. **Pickup scan on a phone**: the green "paid" result for Hafiz's invoice, in a phone frame.

## Testing instructions

Live app: https://chatching.onrender.com/

First load can take up to a minute while the free server wakes up.

Each judge gets their own fresh table: nobody else can see or change your orders. No login is needed.

1. Your table starts empty. Click **Load demo**, then **Read orders**. The demo uses a saved AI reply, so it works even if the AI is busy.
2. Click **Send invoices**. Each buyer gets a real PayPal sandbox invoice (no emails are sent).
3. Click **Payer link** on a sent row to open PayPal's payment page for that invoice.
4. Click a buyer, then **Record payment** to record cash. The row shows Paid (cash/bank).
5. Click **Kitchen list** to see what to make per day.
6. Have a phone with you? Click **Open on my phone** and scan the QR with the phone's camera. The phone opens the same orders, so you can try **Pickup scan** there on a buyer's QR. The QR works once, for 10 minutes.
7. Click **Reset demo** at the bottom to start again. It only clears your own table.

The free server sleeps after 15 minutes without visitors, and that clears tables. If yours is cleared, the page says so: click **Load demo**, then **Read orders**. Invoices already sent stay safe in PayPal.

Sandbox buyer logins for paying an invoice (practice accounts with fake money): see the README’s "Judge test accounts" section, filled in on Sat 7 Nov.

## Devpost Additional info answers

### If you used AG Grid, what was your experience building with AG Grid/AG Charts/AG Studio?

AG Grid Community (v36, loaded from jsDelivr with a pinned version and integrity hash) is the heart of ChatChing's screen: one row per buyer, showing their items, date, total and live PayPal status.

What I used: custom cell renderers (buyer avatars, item chips, status badges, the PayPal payer link with a Copy button), rowClassRules to turn unclear orders amber, a pinned totals row, quick-filter search, an external filter behind the "Check" card that shows only the orders to check, pagination driven by my own page arrows (AG Grid's own panel is hidden), CSV export built with AG Grid's getDataAsCsv (the app adds a UTF-8 mark for Excel and blocks spreadsheet formulas in every cell), and flashCells to flash a row green when a buyer pays. While invoices are being sent, the app redraws only the finished buyer's row (redrawRows with rowNodes), so the table updates live without flickering.

What was hard: making the table fit its panel at every width. On laptops and tablets the app chooses which columns to show from the table's own width, not the screen's, and on phones it switches to one card per buyer, so it works on laptops, tablets and phones. AG Grid's theme also needed inline styles and data: fonts, which I allowed in the Content-Security-Policy while keeping scripts strictly locked to the app's own files and the two pinned CDN files.

I stayed on the free Community edition. Features like row grouping are Enterprise-only, so the Kitchen list (what to make per day) is built in the app's own code instead. As a first-year student, AG Grid let me ship a professional, responsive table in days instead of weeks.

## TODO

- [ ] Video link (YouTube, public, under 3 minutes): to add after recording.
- [ ] Sandbox buyer logins (Sat 7 Nov).
- [ ] Devpost text and Built with tags pasted into Devpost (Sat 7 Nov).
- [ ] Gallery: `npm run gallery`, check the 6 images, upload them (Mon 9 Nov).
- [ ] GitHub link in Try it out, once the repo is public (Tue 10 Nov).
- [x] "thousands" needed a real source: changed to "many" (2 Nov).
- [x] Inspiration replaced with Jasper’s own words (3 Nov).
