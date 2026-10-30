// The daily AI call counter (Step 9, PLAN.md Section 6). Google's free tier gives each model about 20
// calls a day, shared by the seller and every judge. We count EVERY real call we start, failed ones too
// (Google may count them), so our estimate errs on the safe side. The count is saved in
// data/runtime/ai-usage.json (git-ignored) so a restart doesn't hand out a fresh 20.
// Google's day starts at midnight Pacific time (an assumption, PLAN.md Section 6). Pacific time has
// summer time, so that is 3 PM Malaysia time until 1 Nov 2026 and 4 PM after: the hour is worked out
// from the real date, never written in by hand.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE_FILE = fileURLToPath(new URL("../data/runtime/ai-usage.json", import.meta.url));
export const DAILY_LIMIT = 20; // per model (DECISIONS.md, AI model limits)

const PACIFIC = "America/Los_Angeles";
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = (ms) => Object.fromEntries(pacific.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));

// The Pacific calendar day of a moment, e.g. "2026-10-30". The counter starts again when it changes.
export function pacificDay(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// The moment the next Pacific day starts. Midnight Pacific is 07:00 or 08:00 UTC (summer or winter
// time): try both on the next day and keep the one that really is midnight there.
export function nextReset(ms) {
  const [y, m, d] = pacificDay(ms).split("-").map(Number);
  for (const utcHour of [7, 8]) {
    const candidate = Date.UTC(y, m - 1, d + 1, utcHour);
    if (parts(candidate).hour === "00" && candidate > ms) return candidate;
  }
  return Date.UTC(y, m - 1, d + 1, 8); // not reached for Pacific time; a safe guess
}

// "3 PM" or "4 PM": when the next Pacific day starts, in Malaysia time (what the seller and judges read).
export const resetHourMalaysia = (ms) =>
  new Date(nextReset(ms)).toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: "numeric" });

// { left(model), take(model), totalLeft() }. take() is called just BEFORE a call starts and saves at once.
// A missing or broken file starts a fresh count (with a warning); a failed save only logs a warning, so
// the counter never stops the app.
export function createUsage({ file = USAGE_FILE, models, limit = DAILY_LIMIT, now = Date.now, log = console.log }) {
  let saved = { day: null, calls: {} };
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (typeof data?.day === "string" && data.calls && typeof data.calls === "object") saved = data;
      else throw new Error("not a usage file");
    } catch (err) {
      log(`Warning: ${file} could not be read (${err.message}), so the AI call count starts at 0.`);
    }
  }

  const today = () => {
    const day = pacificDay(now());
    if (saved.day !== day) saved = { day, calls: {} }; // a new Pacific day: everyone gets their 20 again
    return saved;
  };
  const used = (model) => {
    const n = today().calls[model];
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const left = (model) => Math.max(0, limit - used(model));

  return {
    left,
    totalLeft: () => models.reduce((sum, model) => sum + left(model), 0),
    take(model) {
      const day = today();
      day.calls[model] = used(model) + 1;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, `${JSON.stringify(day, null, 2)}\n`);
        renameSync(`${file}.tmp`, file);
      } catch (err) {
        log(`Warning: the AI call count could not be saved (${err.message}).`);
      }
    },
  };
}
