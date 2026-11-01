# Accuracy check

How well ChatChing reads chats it was not built on. Two third-party test sets, each with its own menu. The chats, menus and expected answers stay in `data/holdout/` (git-ignored); only the scores and differences are here.

**Status on 1 Nov 2026: no score yet.** Google said "high demand" on the first call, so the run stopped at once. Nothing below is a score until the table says so.

| Set | Label | Messages | Orders | Live run | Score | Seconds | Calls |
|---|---|---|---|---|---|---|---|
| A "cafe-usd" | real orders, reformatted by AI; names added by us | 40 | 10 | 1 Nov, 2:20 PM MYT: HTTP 503 "high demand" | none | 38.9 s to the refusal | 1 of 2 |
| B "daily-grind" | AI-written third-party test set | 93 | 10 | not run: stopped after Set A | none | none | 0 of 2 |

The demo chats are a separate check: the saved reply scores 74/74 (`npm run check`). They are chats we wrote ourselves, so that number shows the pipeline works, not how well the AI reads other sellers.

## How these sets are scored

- Expected answers were written from each seller's **menu and our rules**, not copied from anyone's answer key.
- An item or add-on that is not on the menu makes the order "needs a check". If the buyer drops that item before the end, the final order is clear.
- A cancelled order is scored on its status only.
- Free requests (less ice, less sweet, pack separately) go in the note and are not scored.
- Prices come from the menu. Prices the seller wrote in the chat are ignored.
- The chats give no delivery date and no buyer says "pickup", so date and pickup/delivery are expected to be empty. Set B's "Pickup" and "Dine-in" labels sit in the order headers, which are not part of the chat.
- Each run is one call to the main model, with up to 180 s to answer. The app itself gives the main model 35 s, and it refuses a paste over 50 messages, so **Set B could not be pasted into the app as it stands**. These are measurements of the reading, not of the app's limits.
- **No prompt tuning after these runs.**

## Expected totals

| Set | Clear orders | Clear total | Need a check | Cancelled |
|---|---|---|---|---|
| A "cafe-usd" | 8 | $136.50 | 1 (Customer E: oat milk is not on the menu) | 1 (Customer D) |
| B "daily-grind" | 2 | RM 43.00 | 7 (Mei, Amir, Sofia, Farid, Ravi, Marcus, Hana) | 1 (Jia) |

## Where the friend's answer key differs from ours (Set B)

8 of the 10 orders differ. In every case the key follows what the seller said in the chat, and ours follows the menu.

| Order | Friend's key | Ours | Why |
|---|---|---|---|
| O001 Aina | RM13 | RM 13.00 | Same. |
| O002 Daniel | RM31 | RM 30.00 | The menu gives 10.00 + 11.00 + 2.00 + 7.00. The seller's RM31 doesn't match it. |
| O003 Mei | RM15 | Needs a check | Strawberry Matcha Latte is not on the menu, so it has no price. |
| O004 Amir | RM23 | Needs a check, RM 9.50 known | Chicken Mayo Sandwich is not on the menu. |
| O005 Sofia | RM23 | Needs a check, RM 15.00 known | Brownie is not on the menu. |
| O006 Farid | RM67 | Needs a check, RM 31.50 known | Chicken Mayo Sandwich and French Fries are not on the menu. |
| O007 Ravi | RM14 | Needs a check, RM 12.50 known | Soy milk is not on the menu. |
| O008 Jia | Cancelled | Cancelled | Same. |
| O009 Marcus | RM17 | Needs a check, RM 10.00 known | Banana Bread is not on the menu. |
| O010 Hana | RM49 | Needs a check, RM 31.50 known | Vanilla syrup and Brownie are not on the menu. |

One difference is only in how it is written: the key puts oat milk and the extra shot inside the drink, and we list each paid add-on as its own item.
