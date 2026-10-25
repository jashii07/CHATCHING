// All settings come from environment variables, read in this ONE place.
// Missing keys never crash the app: we only record true/false for each one.
// Locally, npm start loads .env (if it exists); on Render, real env vars are set in the dashboard.
import { inspect } from "node:util";

const AI_MODES = ["mock", "real", "off"]; // mock = saved answers, real = Gemini, off = non-AI parser
const KEY_NAMES = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "GEMINI_API_KEY"];

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

  // true/false only: safe to log and to send to the page.
  const keysPresent = Object.fromEntries(KEY_NAMES.map((name) => [name, read(name) !== ""]));
  if (aiMode === "real" && !keysPresent.GEMINI_API_KEY) {
    warnings.push('AI_MODE is "real" but GEMINI_API_KEY is missing, so AI calls will fail.');
  }

  return Object.freeze({
    port,
    aiMode,
    paypal: hideWhenPrinted({ clientId: read("PAYPAL_CLIENT_ID"), clientSecret: read("PAYPAL_CLIENT_SECRET") }),
    gemini: hideWhenPrinted({ apiKey: read("GEMINI_API_KEY") }),
    keysPresent: Object.freeze(keysPresent),
    paypalConfigured: keysPresent.PAYPAL_CLIENT_ID && keysPresent.PAYPAL_CLIENT_SECRET,
    geminiConfigured: keysPresent.GEMINI_API_KEY,
    warnings: Object.freeze(warnings),
  });
}
