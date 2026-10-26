// Money is counted in sen (1 RM = 100 sen) as whole numbers, never floats.
// Floats can't hold 0.10 exactly, so 0.10 + 0.20 gives 0.30000000000000004.
// Whole numbers add up exactly. We only turn sen back into "54.00" for display.

// "18.00" -> 1800. Only plain strings like "18", "18.5" or "18.00"; anything else throws.
export function toSen(price) {
  const match = typeof price === "string" ? price.match(/^(\d+)(?:\.(\d{1,2}))?$/) : null;
  if (!match) throw new TypeError(`Not a money amount: ${JSON.stringify(price)}`);
  const [, ringgit, cents = ""] = match;
  return Number(ringgit) * 100 + Number(cents.padEnd(2, "0"));
}

// 1800 -> "18.00". Only whole, non-negative sen.
export function fromSen(sen) {
  if (!Number.isSafeInteger(sen) || sen < 0) throw new TypeError(`Not a whole number of sen: ${JSON.stringify(sen)}`);
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`;
}
