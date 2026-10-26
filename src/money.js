// Money is counted in cents ("sen" for MYR: 1/100 of the currency) as whole numbers, never floats.
// Floats can't hold 0.10 exactly, so 0.10 + 0.20 gives 0.30000000000000004.
// Whole numbers add up exactly. We only turn sen back into "54.00" for display.
// The currency is one setting, "currency" in data/menu.json; nothing here assumes ringgit.

// "18.00" -> 1800. Only plain strings like "18", "18.5" or "18.00"; anything else throws.
export function toSen(price) {
  const match = typeof price === "string" ? price.match(/^(\d+)(?:\.(\d{1,2}))?$/) : null;
  if (!match) throw new TypeError(`Not a money amount: ${JSON.stringify(price)}`);
  const [, whole, cents = ""] = match;
  return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
}

// 1800 -> "18.00". Only whole, non-negative sen.
export function fromSen(sen) {
  if (!Number.isSafeInteger(sen) || sen < 0) throw new TypeError(`Not a whole number of sen: ${JSON.stringify(sen)}`);
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`;
}

// "54.00" + "MYR" -> "RM 54.00", + "USD" -> "$54.00". The locale is fixed ("en") so the server and
// every browser show the same text; "narrowSymbol" gives "RM" and "$" instead of "MYR" and "US$".
// public/app.js uses the same Intl options for the table.
export function formatMoney(amount, currency) {
  const sen = toSen(amount);
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError(`Not a currency code: ${JSON.stringify(currency)}`);
  }
  return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(sen / 100);
}
