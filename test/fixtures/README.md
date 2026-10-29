# Test fixtures

| File | What it is |
|------|------------|
| `real-order-no-timestamp.txt` | A real-style order message: based on a real chat, translated to English, with the name and phone number changed. It has NO timestamp, because that is how a single copied message looks. Kept for the AI reality check later. |
| `accuracy/perfect.json` | A raw Gemini-style reply holding exactly the orders in `data/expected-orders.json` (fictional). Used by `test/accuracy.test.js`. |
| `accuracy/wrong-qty.json` | The same, but Jun Wei has 1 Cheese brownies instead of 2. |
| `accuracy/missing-buyer.json` | The same, but Priya's order is missing. |
| `accuracy/wrong-cancellation.json` | The same, but Danish's cancelled order is "active". |
