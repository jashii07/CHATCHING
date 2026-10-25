# Demo data

**All data in this folder is FICTIONAL and for illustration only.** The seller, buyers, menu, prices and chat messages are made up. Any resemblance to real people or businesses is coincidental.

| File | What it is |
|------|------------|
| `menu.json` | The seller's fixed menu. Prices are in MYR. This is the ONLY source of prices: the AI never sets a price. |
| `demo-chats.txt` | One day of chat orders (Wed 28 Oct 2026) in mixed English/Malay. One message per line. |
| `expected-orders.json` | The correct answers for `demo-chats.txt`, used to measure AI accuracy. `messages` are 1-based line numbers in `demo-chats.txt`. |

Date words in the chats, counted from Wed 28 Oct 2026: "esok" (tomorrow) = Thu 29 Oct, "Friday" = Fri 30 Oct, "sabtu" (Saturday) = Sat 31 Oct, "ahad" (Sunday) = Sun 1 Nov.

Expected result: 7 clear orders worth RM 387.00, 1 unclear (Priya), 1 cancelled (Danish), and 1 message that is not an order (Lina's payment-link request).
