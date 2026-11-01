// All settings come from environment variables, read in this ONE place.
// Missing keys never crash the app: we only record true/false for each one.
// Locally, npm start loads .env (if it exists); on Render, real env vars are set in the dashboard.
import { inspect } from "node:util";

const AI_MODES = ["mock", "real", "off"]; // mock = saved answers, real = Gemini, off = non-AI parser
const KEY_NAMES = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "GEMINI_API_KEY"];
const SANDBOX = "https://api-m.sandbox.paypal.com";

// Secrets live in these boxes. Code can read config.paypal.clientSecret,
// but printing the config or turning it into JSON shows "[hidden]".
function hideWhenPrinted(secrets) {
  Object.defineProperties(secrets, {
    toJSON: { value: () => "[hidden]" },
    [inspect.custom]: { value: () => "[hidden]" },
  });
  return Object.freeze(secrets);
}

export function loadConfig(env = process.env) {
  const read = (name) => (env[name] ?? "").trim();
  const warnings = [];

  let port = 3000;
  if (read("PORT")) {
    const n = Number(read("PORT"));
    if (Number.isInteger(n) && n >= 0 && n <= 65535) port = n;
    else warnings.push(`PORT "${read("PORT")}" is not a valid port number, so 3000 is used.`);
  }

  let aiMode = "mock";
  if (read("AI_MODE")) {
    const mode = read("AI_MODE").toLowerCase();
    if (AI_MODES.includes(mode)) aiMode = mode;
    else warnings.push(`AI_MODE "${read("AI_MODE")}" is not one of ${AI_MODES.join(", ")}, so "mock" is used.`);
  }

  // Sandbox only (cut list: no live PayPal). Anything else stops the server: a typo must never
  // send real invoices. PAYPAL_BASE_URL is optional; it exists only so this rule can be checked.
  const paypalBaseUrl = (read("PAYPAL_BASE_URL") || SANDBOX).replace(/\/+$/, "");
  if (paypalBaseUrl !== SANDBOX) {
    throw new Error(`PAYPAL_BASE_URL must be ${SANDBOX} (ChatChing only uses the PayPal sandbox), not "${paypalBaseUrl}".`);
  }

  // true/false only: safe to log and to send to the page.
  const keysPresent = Object.fromEntries(KEY_NAMES.map((name) => [name, read(name) !== ""]));
  if (aiMode === "real" && !keysPresent.GEMINI_API_KEY) {
    warnings.push('AI_MODE is "real" but GEMINI_API_KEY is missing, so AI calls will fail.');
  }

  // Render always sets RENDER (render.com/docs/environment-variables). There the server must listen on
  // 0.0.0.0 (render.com/docs/web-services) and sits behind Render's proxy, which passes the visitor's
  // address in X-Forwarded-For (used by the rate limit, src/rate-limit.js). Anywhere else it listens on this
  // computer only, so nobody on the same Wi-Fi can reach a laptop's server that holds real keys.
  const onRender = read("RENDER") !== "";

  return Object.freeze({
    port,
    host: onRender ? "0.0.0.0" : "127.0.0.1",
    onRender,
    aiMode,
    paypal: hideWhenPrinted({ clientId: read("PAYPAL_CLIENT_ID"), clientSecret: read("PAYPAL_CLIENT_SECRET") }),
    paypalBaseUrl,
    gemini: hideWhenPrinted({ apiKey: read("GEMINI_API_KEY") }),
    keysPresent: Object.freeze(keysPresent),
    paypalConfigured: keysPresent.PAYPAL_CLIENT_ID && keysPresent.PAYPAL_CLIENT_SECRET,
    geminiConfigured: keysPresent.GEMINI_API_KEY,
    warnings: Object.freeze(warnings),
  });
}
