# Accuracy check

How well ChatChing reads chats it was not built on. Two third-party test sets, each with its own menu. The chats, menus and expected answers stay in `data/holdout/` (git-ignored); only the scores and differences are here.

| Set | Label | Messages | Orders | Score | Seconds | Model | Calls |
|---|---|---|---|---|---|---|---|
| A "cafe-usd" | real orders, reformatted by AI; names added by us | 40 | 10 | **73/74** | 28.2 s | gemini-3.6-flash | 2 (the first got a 503 on 1 Nov, 38.9 s, no score) |
| B "daily-grind" | AI-written third-party test set | 93 | 10 | **74/74** | 24.1 s | gemini-3.6-flash | 1 |

Both scores are from one live run each, on 1 Nov 2026 at 2:32 PM MYT, through the app's own AI code. **The prompt was not tuned on these sets, and it won't be.** One run shows what happened that day, not an average.

The demo chats are a separate check: the saved reply scores 74/74 (`npm run check`). We wrote those chats ourselves, so that number shows the pipeline works, not how well the AI reads other sellers.

## Set A "cafe-usd": real orders, reformatted by AI; names added by us

| What | Score |
|---|---|
| buyers | 10/10 |
| cancellations | 10/10 |
| items | 9/9 |
| quantities | 9/9 |
| dates | 9/9 |
| unclear flags | 8/9 |
| pickup/delivery | 9/9 |
| prices | 9/9 |

**Differences (1):**

- Customer E: unclear flag: expected needs a check, AI said clear. Customer E asked for oat milk, which the seller's menu doesn't have. The AI read the items right, but wrote "With oat milk." in the note instead of reporting it as not on the menu.

**What that miss would do in the app:** Customer E shows as ready to invoice, not amber. The app would show 9 orders ready, $146.00, and 0 to check. The right answer is 8 orders, $136.50, and 1 to check. The seller would invoice $9.50 from the menu without being told about the oat milk, and it would only be visible in the note.

Our own checks on the reply (message numbers, dates, note length): all fine.

## Set B "daily-grind": AI-written third-party test set

| What | Score |
|---|---|
| buyers | 10/10 |
| cancellations | 10/10 |
| items | 9/9 |
| quantities | 9/9 |
| dates | 9/9 |
| unclear flags | 9/9 |
| pickup/delivery | 9/9 |
| prices | 9/9 |

**Differences (0):** none: a perfect score.

The app would show 2 orders ready, RM 43.00, and 7 to check, the same as the expected answers. Our own checks on the reply: all fine.

## How these sets are scored

- Expected answers were written from each seller's **menu and our rules**, not copied from anyone's answer key.
- An item or add-on that is not on the menu makes the order "needs a check". If the buyer drops that item before the end, the final order is clear.
- A cancelled order is scored on its status only.
- Free requests (less ice, less sweet, pack separately) go in the note and are not scored.
- Prices come from the menu. Prices the seller wrote in the chat are ignored.
- The chats give no delivery date and no buyer says "pickup", so date and pickup/delivery are expected to be empty. That makes those two scores easy. Set B's "Pickup" and "Dine-in" labels sit in the order headers, which are not part of the chat.
- The score counts what the app would show, after our own checks.
- Each run was one call to the main model, with up to 180 s to answer. Both answered in under 30 s, inside the app's time limit.
- Set B's result set the app's paste limit: since 1 Nov it reads up to 120 messages or 15,000 characters, so Set B can now be pasted into the app.

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
