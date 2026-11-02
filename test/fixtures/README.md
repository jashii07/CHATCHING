# Test fixtures

| File | What it is |
|------|------------|
| `made-up-order-no-timestamp.txt` | A made-up order message, with a form-style layout and invented name, food and phone number. It has NO timestamp, because that is how a single copied message looks. Nothing in it comes from a real chat. |
| `accuracy/perfect.json` | A raw Gemini-style reply holding exactly the orders in `data/expected-orders.json` (fictional). Used by `test/accuracy.test.js`. |
| `accuracy/wrong-qty.json` | The same, but Jun Wei has 1 Cheese brownies instead of 2. |
| `accuracy/missing-buyer.json` | The same, but Priya's order is missing. |
| `accuracy/wrong-cancellation.json` | The same, but Danish's cancelled order is "active". |
| `paypal-qr.png` | A real PayPal sandbox QR image (300 x 300 px) from a test invoice, holding `https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1`. `npm run ui-pickup` shows it to Chromium's fake camera. Sandbox only, no real money, no personal data. |
