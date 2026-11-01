# Demo data

**All data in this folder is FICTIONAL and for illustration only.** The seller, buyers, menu, prices and chat messages are made up. Any resemblance to real people or businesses is coincidental.

| File | What it is |
|------|------------|
| `menu.json` | The seller's fixed menu. Prices are in MYR. This is the ONLY source of prices: the AI never sets a price. Each item may have an `icon` (a Lucide icon name such as `cookie` or `cake-slice`) shown on its item chip, and `"addon": true` for a paid add-on, listed as its own item with its own quantity. `sellerName` is the seller's name in the chats: their messages are context only and never become an order. |
| `demo-chats.txt` | One day of chat orders (Wed 28 Oct 2026) in English. One message per line. |
| `expected-orders.json` | The correct answers for `demo-chats.txt`, used to measure AI accuracy. Orders use the same field names as the AI output (PLAN.md Section 5). `sourceMsgs` are 1-based line numbers in `demo-chats.txt`. `total`, `notOrders` and `summary` are extra fields for checking only; the AI never returns prices. |
| `ai-cache/demo-parse.json` | Gemini's REAL reply (gemini-3.6-flash, 27 Oct 2026) for `demo-chats.txt`, saved byte for byte by `scripts/spike-parse.mjs`. Mock mode and the demo use it (0 AI calls). It scored perfectly against `expected-orders.json`. `demo-parse.meta.json` holds the call's time (17.6 s), token counts and input hash. No keys inside. |

The demo's fixed chat date is `chatDate: "2026-10-28"` in `expected-orders.json`, so the dates are the same on any day. Date words in the chats, counted from Wed 28 Oct 2026: "tomorrow" = Thu 29 Oct, "Friday" = Fri 30 Oct, "Saturday" = Sat 31 Oct, "this Sunday" = Sun 1 Nov.

Expected result (Step 7, 18 messages): 7 clear orders worth RM 366.00; 2 that need a check (Priya wrote plain "brownies"; Jun Wei wrote "Classic is RM15 right?" but the menu says RM 18.00); 1 cancelled (Danish); and 2 messages that are not orders (Arif's question, Lina's payment-link request). It also has a quantity change (Lina, Kak Ros), "same as Lina" (Aisyah), a cancelled add-on (Hafiz's cookies) and a correct price mention (Mei Ling's RM72).

## Holdout chats: privacy checklist

The folder `data/holdout/` (git-ignored) holds test chats, menus and expected answers. Since 1 Nov it has two sets, `cafe-usd` (real orders, reformatted by AI; names added by us) and `daily-grind` (AI-written third-party test set); their results are in `docs/accuracy.md`. It may also hold REAL messages from a seller and their expected answers, used ONCE to test the AI on chats it was not tuned for (`scripts/accuracy.mjs --live --chats ...`). Nothing in it is committed until the names and phone numbers are replaced AND the seller agrees. Before committing, tick every box:

- [ ] Names changed (buyers, the seller, anyone mentioned).
- [ ] Phone numbers changed or removed.
- [ ] Addresses changed or removed.
- [ ] Places changed (areas, landmarks, schools, offices).
- [ ] Events changed (weddings, kenduri, birthdays with names or dates that point to someone).
- [ ] Anything else that could identify a buyer changed or removed (emails, account numbers, social handles, photos).
- [ ] The messy writing style is KEPT: typos, short forms, emoji.
- [ ] My friend's permission covers a **public GitHub repo** AND sending the chats to **Google's Gemini free tier** (where "human reviewers may read" inputs).
