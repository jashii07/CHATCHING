// Backup protection for every reply and every changing request. No script injection was found in the review
// (1 Nov), so these are a second lock on the door, not the only one.
// Content-Security-Policy: a list the browser enforces of what this page may load and run.
//   script-src: our own files only. AG Grid and Lucide are served from public/vendor/ since 6 Nov (no CDN, so a
//     network that blocks jsDelivr still gets the table). No inline scripts and never 'unsafe-eval'.
//   style-src: 'unsafe-inline' is needed because AG Grid adds its theme as a <style> tag from JavaScript, and a
//     nonce would need a page built per request (this app serves plain files). It lets in styles, never scripts.
//   img-src data: is for the QR images, which arrive as Base64 pictures (and the empty favicon link).
//   font-src data: is for AG Grid's icon fonts, which sit as text inside its pinned, hash-checked file. Browsers
//     have no way to allow one data: font by hash. A data: font holds all its bytes itself, so it reaches nothing.
const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'", // no other site may show this page in a frame (a trick called clickjacking)
].join("; ");

const HEADERS = {
  "Content-Security-Policy": POLICY,
  "X-Content-Type-Options": "nosniff", // a file is only ever what its type says, never guessed
  "Referrer-Policy": "same-origin", // other sites never learn which page sent a visitor to them
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()", // Pickup scan's camera, nothing else
};

export function securityHeaders(req, res, next) {
  res.set(HEADERS);
  next();
}

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const OTHER_SITE = "This request came from another website, so it was refused.";

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null; // "null" (a sandboxed page) and anything else that isn't an address
  }
}

// CSRF: another website making a visitor's browser send a request here, with their cookie. Browsers put the
// real sender in the Origin header, and a page can't fake it. No Origin (a script, an old browser) is let
// through, because the cookie's SameSite setting already covers those. Host, not protocol: on Render the
// server sees plain http from Render's proxy, while the browser's Origin says https.
export function sameSiteOnly(req, res, next) {
  const { origin, host } = req.headers;
  if (!CHANGES.has(req.method) || origin === undefined || hostOf(origin) === host) return next();
  res.status(403).json({ error: OTHER_SITE });
}
