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
| 2026-10-25 | Add Top 5 standout features (PLAN.md Section 10): 1 show your work, 2 ready-to-send messages, 3 PayPal as the record of payments, 4 CSV export + Paid flash, 5 real-seller proof. If short on time keep 5, 4, 1, 2, 3 | _TBD: your reason, in your own words_ | Base plan only; judge-first screen and other Stretch items |
| 2026-10-25 | Extra time: 3-6 h extra on each weekend day (31 Oct, 1 Nov, 7 Nov, 8 Nov); plan uses the low end, 3 h/day (46 h total) | "the extra hours is like extra 3-6 hours on weekend" | Plan with 6 h/day (no buffer) |
| 2026-10-25 | Record cash / bank transfer through PayPal's record-payment API | Sandbox test: UNPAID → MARKED_AS_PAID with method CASH, so PayPal stays the one record of payments | Track cash only in our own JSON |
| 2026-10-25 | Pickup QR from PayPal's generate-qr-code API (only for pickup orders) | Sandbox test: returns a Base64 PNG inside multipart/form-data; decoded to a valid QR | Draw our own QR from the payer link (needs a package) |
| 2026-10-25 | Double-invoice guard = server check + per-buyer lock + unique invoice_number; no PayPal-Request-Id | Sandbox test: same PayPal-Request-Id created 2 invoices (not honoured, not documented for Invoicing); duplicate invoice_number refused with 422 DUPLICATE_INVOICE_NUMBER | PayPal-Request-Id only |
| 2026-10-25 | CSV export instead of Excel .xlsx; flash only the change to Paid | Excel export is AG Grid Enterprise; CSV export and cell flashing are Community | Excel export (Enterprise trial) |
| 2026-10-25 | Holdout = friend's real chats, anonymised, with permission covering a public repo + Gemini free tier | Gemini free-tier terms: inputs may improve Google products, human reviewers may read them, "do not submit ... personal information" | Fictional holdout chats |
| 2026-10-25 | Cut: "ask the agent" chat box; AI sending invoices/messages without the seller's approval | The chat box burns AI quota; the seller must stay in control of money and messages | Build them |

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
- With the Top 5 added, Mon 2 – Fri 6 Nov holds ~11 h of work in 10 h, and Fri 6 Nov has two jobs (user test + fallback parser). Slips go into the extra weekend hours; if those aren't there either, cut 3, then 2, then 1.
- Gemini free tier: Google may use inputs to improve its products and human reviewers may read them. Fine for fictional/anonymised demo data; a real seller would need the paid tier.
- The QR code reply format (Base64 PNG inside multipart/form-data) is not documented. If PayPal changes it, the QR button breaks; the code checks for the PNG signature and shows an error instead of a broken image.
- Recording a cash/bank payment has no undo planned.
