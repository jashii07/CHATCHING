# Decisions

| Date | Decision | My reason | Alternatives |
|------|----------|-----------|--------------|
| 2026-10-25 | Join PayPal AI Hackathon | My goal is experience: learn to direct AI and practise vibe coding; prizes are a bonus | Plan B: HackOnVibe + next Orchestrate |
| 2026-10-25 | AI model at runtime: Gemini free tier (candidate, not final) | Both models are free, but 3.6-flash answered every time in my test while 3.8-flash was overloaded, so I picked the one that is free AND reliable. (Earlier: free, no billing set up, judges can use the demo without me paying.) | Groq free tier, Claude API (paid) |
| 2026-10-25 | App idea: Chat-to-Checkout | My seller friend tracks chat orders in Excel by hand and chases payments one by one, so the problem is real. It also fits AI-in-batches (20 calls/day), an AG Grid table and PayPal invoices | Club treasurer copilot, split-bill agent, subscription watchdog, freelancer invoice chaser |
| 2026-10-25 | Architecture: Option A, one simple server (Express + plain HTML/JS + AG Grid from CDN, polling for status) | it's simpler, so it reduces my workload and saves more time for the other parts of this competition, like testing, the README and the video | Option B (React + webhooks + database) |
| 2026-10-25 | Buyer contact: payment link the seller pastes into the chat; buyer email optional | Matches how sellers really work in chat | Require buyer email for every invoice |
| 2026-10-25 | Prices: fixed menu (item -> price) in a JSON file; AI picks only item + quantity, code calculates totals | The AI must never invent a price | AI reads prices from the chat |
| 2026-10-25 | Currency: test MYR first, USD if sandbox rejects it | MYR is realistic for Malaysian sellers | USD only |
| 2026-10-25 | Reminders: AI drafts text + "Copy" button; PayPal remind endpoint is a stretch goal | Seller pastes it into the chat themselves | Send reminders through PayPal |
| 2026-10-25 | Judges: one shared demo + "Reset demo" (preloaded data + saved AI results, 0 AI calls) + "AI calls left today: X/20" | Free tier has 20 calls/day shared with judges | A separate copy per visitor |
| 2026-10-25 | Pin an exact AG Grid Community version from the CDN | An unpinned version could change and break the demo before judging ends | Load "latest" |
| 2026-10-25 | Use MYR for invoices; payer link = send response `href` with `rel: "payer-view"` | Smoke test: MYR draft accepted, sent invoice became UNPAID, send returned the payer-view link | USD; build the link from `recipient_view_url` |
| 2026-10-25 | Pin AG Grid Community 36.2.0 (jsDelivr) | Newest release (16 Sep 2026), over a month old, file confirmed on the CDN | 36.1.0 |
| 2026-10-25 | PLAN.md approved with changes | Plan covers the full flow, AI limits and dated checkpoints; changes below make it more accurate and showcase AG Grid | Approve as drafted |
| 2026-10-25 | Menu aliases; plain "brownies"/"brwnies" = unclear row | One word must not silently pick the wrong item: "which brownies: classic or cheese?" | Map plain "brownies" to classic |
| 2026-10-25 | AI returns the FINAL order per buyer (status active/cancelled, sourceMsgs, itemId may be null) | Real chats change, add to and cancel orders in later messages; questions and payment requests are not orders | One row per message, seller merges by hand |
| 2026-10-25 | Resolve day words from each message's own timestamp | The demo gives the same dates in December as in October | Resolve from today's date |
| 2026-10-25 | Add scripts/accuracy.mjs (mock default, --real) + later holdout chats | Measure AI accuracy with a score, and test on chats the prompt wasn't tuned on | Judge accuracy by eye |
| 2026-10-25 | AG Grid showcase, Community features only (no row grouping) | Targets the AG Grid sponsor prize with the free version | Plain HTML table; Enterprise trial |
| 2026-10-25 | 7 Nov: video script + Devpost draft; 9 Nov: test an English-language sandbox buyer before recording | Avoid last-minute surprises in the video and submission | Do it all on 10-11 Nov |
| 2026-10-25 | Add Top 5 standout features (PLAN.md Section 10): 1 show your work, 2 ready-to-send messages, 3 PayPal as the record of payments, 4 CSV export + Paid flash, 5 real-seller proof. If short on time keep 5, 4, 1, 2, 3 | Each feature solves a real seller problem or proves the app works. (Details under the table.) | Base plan only; judge-first screen and other Stretch items |
| 2026-10-25 | Extra time: 3-6 h extra on each weekend day (31 Oct, 1 Nov, 7 Nov, 8 Nov); plan uses the low end, 3 h/day (46 h total) | "the extra hours is like extra 3-6 hours on weekend" | Plan with 6 h/day (no buffer) |
| 2026-10-25 | Record cash / bank transfer through PayPal's record-payment API | Sandbox test: UNPAID → MARKED_AS_PAID with method CASH, so PayPal stays the one record of payments | Track cash only in our own JSON |
| 2026-10-25 | Pickup QR from PayPal's generate-qr-code API (only for pickup orders) | Sandbox test: returns a Base64 PNG inside multipart/form-data; decoded to a valid QR | Draw our own QR from the payer link (needs a package) |
| 2026-10-25 | Double-invoice guard = server check + per-buyer lock + unique invoice_number; no PayPal-Request-Id | Sandbox test: same PayPal-Request-Id created 2 invoices (not honoured, not documented for Invoicing); duplicate invoice_number refused with 422 DUPLICATE_INVOICE_NUMBER | PayPal-Request-Id only |
| 2026-10-25 | CSV export instead of Excel .xlsx; flash only the change to Paid | Excel export is AG Grid Enterprise; CSV export and cell flashing are Community | Excel export (Enterprise trial) |
| 2026-10-25 | Holdout = friend's real chats, anonymised, with permission covering a public repo + Gemini free tier | Gemini free-tier terms: inputs may improve Google products, human reviewers may read them, "do not submit ... personal information" | Fictional holdout chats |
| 2026-10-25 | Cut: "ask the agent" chat box; AI sending invoices/messages without the seller's approval | The chat box burns AI quota; the seller must stay in control of money and messages | Build them |
| 2026-10-25 | Name: ChatChing (chat + "cha-ching", the cash register sound); invoice numbers `CHATCHING-{batch}-{nn}` (21 of PayPal's max 25 chars; first planned as `CHING-`) | it has the sound of cash and coins, and it sounds more familiar and less boring than Chat-to-Checkout | Chat-to-Checkout; Ching-Chat (rejected: could be misread as mocking Chinese speech) |
| 2026-10-25 | Invoice number prefix `CHATCHING-` instead of `CHING-` | it matches the full name and avoids "CHING" on its own | `CHING-` (17 chars) |
| 2026-10-25 | First Render deploy on Sat 31 Oct (buffer hour), a "walking skeleton"; check Render free-tier rules that day and stop if it asks for a card | Hosting problems should show up early, not on 5 Nov | Deploy only on 5 Nov |
| 2026-10-25 | GitHub repo jashii07/CHATCHING (private for now); push at the end of every session; never amend, rebase or force-push pushed commits | GitHub is my backup; rewriting pushed history can lose work | Local-only until submission |
| 2026-10-25 | Year rule for timestamps without a year: a "Chat date" field (default today; demo fixed at 2026-10-28); each message's year = the most recent year in which its day/month is not after the chat date. Never based on today's date (replaces the "not in the future" rule in the row "Resolve day words…") | the demo must give the same dates on any day | Most recent year not in the future, based on today (breaks before 28 Oct 2026: picks 2025, so "sabtu" becomes Sat 1 Nov 2025) |
| 2026-10-25 | `data/expected-orders.json` uses the same field names as the AI output in PLAN.md Section 5 (status active/cancelled, sourceMsgs, fulfilment, unclear, reason, note); same answers | The accuracy script can compare directly, with no name translation | Keep the old names and translate in the script |
| 2026-10-25 | Year rule changed to "nearest date": the year (chat date's year, or one before/after) that puts the message nearest the chat date; warning "Check the Chat date" if the result is after the chat date or more than 60 days away; impossible dates (e.g. [29/2] in a non-leap year) = unclear row (replaces the "not after the chat date" rule above) | no silent wrong dates | "Most recent year not after the chat date" (silently moved [29/10] with chat date 28 Oct 2026 to 2025) |
| 2026-10-25 | Lina's expected fulfilment = "delivery" | "hantar" means deliver | Leave it null |
| 2026-10-25 | Start Step 1 tonight (Sun 25 Oct) instead of Mon 26 Oct | if we start earlier we get a stronger foundation, so fewer errors in later steps | Start on Mon 26 Oct as planned |
| 2026-10-25 | package.json: name `chatching`, `"type": "module"`, `"engines": { "node": ">=24" }`, start = `node --env-file-if-exists=.env server.js`; only express installed, pinned to exactly 5.3.0 | one module style everywhere; so Render uses the same Node version as my laptop; Render has no .env file and plain --env-file crashes when it's missing. (Pin: 5.3.0 was released 9 Oct 2026, over 2 weeks old; same reason as pinning AG Grid.) | CommonJS; plain `--env-file`; `"^5.3.0"` |
| 2026-10-25 | Load AG Grid with an integrity hash (sha384) and check at page load that the CSV export, cell flashing and quick filter modules are registered (one console line). No module-registration code: the UMD bundle ends with `registerModules([AllCommunityModule])` | The browser refuses the file if the CDN ever serves different bytes; the console line proves in the real browser that the 3 features are in the bundle (the bundle defines 86 Community modules, 0 Enterprise) | No hash; trust the docs; register modules by hand |
| 2026-10-25 | Hours update: 4 h extra on each weekend day (6 h total on 31 Oct, 1 Nov, 7 Nov, 8 Nov); plan stays at 5 h, the 6th hour is buffer (replaces the "3-6 h" row) | Keep the plan unchanged and add 4 h of buffer | Plan 6 h/day with no buffer |
| 2026-10-25 | `"engines": { "node": "24.x" }` (replaces `">=24"` in the package.json row above). Checked with npm's semver: v24.15.0 (laptop) and v24.22.1 (Render's default) match; v25 and v26 don't | to prevent syntax errors and broken dependencies | `">=24"`: Render's docs say an unbounded range "always resolves to the latest release of Node.js" |
| 2026-10-25 | New Step 3b "AI reality check" on Wed 28 Oct: `scripts/spike-parse.mjs` makes ONE real gemini-3.6-flash call on the demo chats (menu, chat date 2026-10-28, the Section 5 JSON schema) and prints the call time and a comparison with expected-orders.json; max 3 real calls that day; the real reply becomes the mock-AI data | fixing now at the earlier stage will save us alot of time compare to fix it in the mid-late process. The AI is the least-proven part; we proved PayPal on day 1, now we prove the AI before building on it | First real Gemini call only in Step 7 (Sun 1 Nov), after building on hand-made mock data |
| 2026-10-25 | Week order: Mon 26 Oct Step 3 (logic + tests), Tue 27 Oct Step 2 (grid, after the UI spec), Wed 28 Oct Step 3b (replaces "Mon 26 Oct starts Step 2"). Claude chose this order: it is the only one that fits all the new dates, and it lets the grid use the price logic and the AI check use dates.js | "I'll fill it from my sketch before the grid step on Tue 27 Oct"; the AI check goes on "Wed 28 Oct - the day freed by finishing Step 1 early" | Step 2 on Mon 26 Oct, before the UI spec exists |
| 2026-10-25 | New PLAN.md Section 12 "UI spec" (placeholder): layout, colours, AG Grid theme, spacing, small-screen behaviour. I fill it from my sketch before Tue 27 Oct; every UI step must follow it | fixing now at the earlier stage will save us alot of time compare to fix it in the mid-late process | Decide the design step by step while building |
| 2026-10-25 | New PLAN.md Section 13 "Video storyboard" (placeholder), drafted by Fri 30 Oct | fixing now at the earlier stage will save us alot of time compare to fix it in the mid-late process; so we build the moments the video needs | Plan the video only with the script on 7 Nov |
| 2026-10-25 | Judge access: on 7 Nov I create 2 sandbox buyer accounts just for judges, and the README lists both. "After submission (12 Nov – 16 Dec)" checklist every 2-3 days (PLAN.md Section 9) | if one gets locked or its password changed, judges use the other. fixing now at the earlier stage will save us alot of time compare to fix it in the mid-late process | One shared test account; no checks after submitting |
| 2026-10-26 | After the deadline, `main` is frozen: tag the submitted commit `submission` and push the tag; only maintenance (restart Render, renew keys in Render's settings, fix judge logins); any code fix needs Devpost's written OK first | The official rules (Section 5) say: "Once the Submission Period has ended, you may not make any changes or alterations to your Submission." (Replaces the Known weakness "RULES.md doesn't say whether fixes are allowed".) | Fix code freely after the deadline |
| 2026-10-26 | The "read MY_RULES.md and PLAN.md first" note now lives in `CLAUDE.md` in the project folder, committed to git. Before, it was only in Claude's memory folder on the laptop (`C:\Users\jaspe\.claude\projects\...\memory\`), which is not backed up | so it is backed up on GitHub | Keep it only in Claude's local memory |
| 2026-10-26 | Step 3 rules for cases the plan didn't cover (Claude's choice): cancelled rows are never "unclear" (only active rows need fixing); `recalcRow` drops the AI's own unclear flag, because the seller's edit counts as the fix; an unknown item id stays visible with the reason `Unknown item "pizza".`; an unknown PayPal status is shown as-is; `matchMenuItem` gives "More than one menu item" when a text names two items; `toSen`/`fromSen` throw on bad input instead of guessing | Nothing is hidden or guessed; the seller always sees why a row is unclear | Keep the AI flag after edits (the seller couldn't clear Priya's row); drop unknown items |
| 2026-10-25 | One fresh Claude Code session per step; each session starts with one explain-back question about the previous step (MY_RULES.md rules 9-10). The Definition of done question moves to the next session's start, so it's one question per step | long sessions use up my plan limit faster; PLAN.md, MY_RULES.md and git hold everything needed. fixing now at the earlier stage will save us alot of time compare to fix it in the mid-late process | One long session (`claude --continue`) |

### Why the Top 5 (my reason)

Each feature solves a real seller problem or proves the app works.
1. **Show your work: trust.** The seller can see why the AI made each order, so they don't have to blindly trust it.
2. **Ready-to-send message: less work.** The seller gets a message to paste, not just a link, and the AI can never write a wrong price.
3. **Cash + pickup QR: real life.** Many buyers pay cash or pick up in person, and PayPal still keeps the full record.
4. **Excel export + paid flash: familiar.** My friend already uses Excel, and it also helps for the AG Grid prize.
5. **Real chats + user test: proof.** Tested on real messages and a real seller, not just made-up data.

## AI model limits (checked 2026-10-25)

Gemini free tier (from my Google AI Studio rate-limit page):

| Model | Requests/minute | Requests/day | Tokens/minute |
|-------|-----------------|--------------|---------------|
| gemini-3.6-flash | 5 | 20 | 250K |
| gemini-3.8-flash | 5 | 20 | 250K |

Groq (backup candidate): free-tier limits NOT confirmed. The official rate-limits page (https://console.groq.com/docs/rate-limits) shows e.g. `openai/gpt-oss-20b` at 30 RPM / 1K RPD, but says these are "the base limits for the Developer plan" (paid). Real free limits only show in the Groq console after sign-up.

## Known weaknesses

- Gemini free tier is not reliable on 2026-10-25: `gemini-3.8-flash` gave 503 "high demand" and once took 147s; `gemini-3.6-flash` took 3.5s-20s. Google says free limits are "not guaranteed" and only shows them in AI Studio. The app will need a timeout, a retry, and a friendly fallback message.
- Only ~20 AI calls/day per model on the Gemini free tier, shared by me and the judges. Planned answers:
  - Batch AI work into few calls.
  - Cache every AI result.
  - Preload demo data with saved AI results.
  - A mock-AI mode for development, so building doesn't use up quota.
  - A non-AI fallback when the quota runs out.
- PayPal reuses an access token until it expires (~9 h), and an old token keeps its old permissions. After ticking Invoicing on 2026-10-25 we still got 403 until we revoked the old token (`POST /v1/oauth2/token/terminate`). If app features change again, revoke the token or restart the server. Put this in the README troubleshooting section.
- The shared demo means two judges using it at the same time can overwrite each other's rows. "Reset demo" puts it back.
- Fitting the accuracy step in moved the Render deploy from 4 to 5 Nov and merged design polish into the 8 Nov buffer day.
- With the Top 5 added, Mon 2 – Fri 6 Nov holds ~11 h of work in 10 h, and Fri 6 Nov has two jobs (user test + fallback parser). Slips go into the buffer hour on 7 or 8 Nov; if that isn't enough, cut 3, then 2, then 1.
- Gemini free tier: Google may use inputs to improve its products and human reviewers may read them. Fine for fictional/anonymised demo data; a real seller would need the paid tier.
- The QR code reply format (Base64 PNG inside multipart/form-data) is not documented. If PayPal changes it, the QR button breaks; the code checks for the PNG signature and shows an error instead of a broken image.
- Recording a cash/bank payment has no undo planned.
- Judge logins are public in the README, so anyone can change a password or lock an account. Two judge accounts and the checks every 2-3 days after submission lower the risk.