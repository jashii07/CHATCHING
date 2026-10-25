# Demo data

**All data in this folder is FICTIONAL and for illustration only.** The seller, buyers, menu, prices and chat messages are made up. Any resemblance to real people or businesses is coincidental.

| File | What it is |
|------|------------|
| `menu.json` | The seller's fixed menu. Prices are in MYR. This is the ONLY source of prices: the AI never sets a price. |
| `demo-chats.txt` | One day of chat orders (Wed 28 Oct 2026) in mixed English/Malay. One message per line. |
| `expected-orders.json` | The correct answers for `demo-chats.txt`, used to measure AI accuracy. `messages` are 1-based line numbers in `demo-chats.txt`. |

Date words in the chats, counted from Wed 28 Oct 2026: "esok" (tomorrow) = Thu 29 Oct, "Friday" = Fri 30 Oct, "sabtu" (Saturday) = Sat 31 Oct, "ahad" (Sunday) = Sun 1 Nov.

Expected result: 7 clear orders worth RM 387.00, 1 unclear (Priya), 1 cancelled (Danish), and 1 message that is not an order (Lina's payment-link request).

## Holdout chats: privacy checklist

`holdout-chats.txt` (added later) will hold REAL messages from a seller, anonymised, used once to test the AI on chats it was not tuned for. Before saving them, tick every box:

- [ ] Names changed (buyers, the seller, anyone mentioned).
- [ ] Phone numbers changed or removed.
- [ ] Addresses changed or removed.
- [ ] Places changed (areas, landmarks, schools, offices).
- [ ] Events changed (weddings, kenduri, birthdays with names or dates that point to someone).
- [ ] Anything else that could identify a buyer changed or removed (emails, account numbers, social handles, photos).
- [ ] The messy writing style is KEPT: typos, short forms, mixed English/Malay, emoji.
- [ ] My friend's permission covers a **public GitHub repo** AND sending the chats to **Google's Gemini free tier** (where "human reviewers may read" inputs).
