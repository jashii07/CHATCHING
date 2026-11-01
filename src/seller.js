// Who wrote a chat message, and whether that was the seller ("sellerName" in menu.json). The seller's replies
// are context only: they never create a buyer or an order, and their prices are never used.
// Pure: no files, no network, no clock.

// "Lina: hi!" -> Lina. A colon inside a time ("at 3:30") is not a sender.
export const SENDER = /^([^:\n]{1,40}):(?:\s|$)/;

const clean = (name) => String(name ?? "").trim().toLowerCase();

export const senderOf = (text) => String(text ?? "").match(SENDER)?.[1].trim() ?? "";
export const sameName = (a, b) => clean(a) === clean(b);

// No sellerName in the menu means nobody is the seller.
export function isSeller(name, menu) {
  const seller = clean(menu?.sellerName);
  return Boolean(seller) && clean(name) === seller;
}

export const isSellerMessage = (msg, menu) => isSeller(senderOf(msg?.text), menu);
