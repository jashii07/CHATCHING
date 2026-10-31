# Devpost draft — ChatChing

## Elevator pitch (on Devpost, max 200 chars)

Business happens in the chat. ChatChing's AI turns a day of messy chats into a clean order list; one click sends every buyer a PayPal pay link. Just chat, confirm, and get paid.

(177 characters)

## What it does (my first draft, my own words - keep my voice)

For thousands of online sellers, business happens in the chat — but managing orders and collecting payments is still a headache. ChatChing turns a full day of messy conversations into a clean, reviewable order list using AI. With one click, sellers can generate PayPal payment links for every buyer. No more digging through endless chats, manually tracking orders, or chasing payments one by one. Just chat, confirm, and get paid.

## Testing instructions

Live app: https://chatching.onrender.com/

First load can take up to a minute while the free server wakes up.

Each judge gets their own fresh table: nobody else can see or change your orders. No login is needed.

1. Your table starts empty. Click **Load demo**, then **Read orders**. The demo uses a saved AI reply, so it works even if the AI is busy.
2. Click **Send invoices**. Each buyer gets a real PayPal sandbox invoice (no emails are sent).
3. Click a buyer, then **Record payment** to record cash. Click **Refresh status**: the row shows Paid (cash/bank).
4. Click **Kitchen list** to see what to make per day.
5. Click **Reset demo** at the bottom to start again. It only clears your own table.

The free server sleeps after 15 minutes without visitors, and that clears tables. If yours is cleared, the page says so: click **Load demo**, then **Read orders**. Invoices already sent stay safe in PayPal.

Sandbox buyer logins for paying an invoice: to add on Sat 7 Nov.

## What's next

- Voice notes as input
- Chat screenshots as input
- Daily stock limits ("only 10 boxes on Saturday")
- More payment methods
- Order history across days
- Analytics (best sellers, busiest days)
- More languages

## TODO

- [ ] "thousands" needs a real source, or change it to "many".
