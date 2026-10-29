// Reading a PayPal invoice id out of text. What PayPal's QR code holds (decoded 29 Oct, Step 7, from two
// real sandbox codes with scripts/decode-qr.mjs):
//   https://www.sandbox.paypal.com/invoice/payerView/details/INV2-BKCU-NGE3-RZG3-U35Y?qr=1
// i.e. the invoice's payer page, with the full invoice id. Step 10c's pickup scan reads the id from it;
// the payer link from the send reply (.../invoice/p/#INV2-...) works the same way.
export function invoiceIdIn(text) {
  const match = String(text ?? "").match(/INV2(?:-[A-Z0-9]{4}){4}/);
  return match ? match[0] : null;
}
