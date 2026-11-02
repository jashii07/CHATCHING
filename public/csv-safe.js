// A buyer picks their own chat name, and the seller opens the export in Excel, which runs a cell starting with
// = + - @ as a formula (a tab or carriage return first can hide that). A leading ' makes such a value plain text.
// It lives in public/ so the page and the tests use the very same code, like invoice-qr.js.
export const safeCell = (value) => (typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
