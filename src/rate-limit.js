// A small per-visitor rate limit for the routes that call Gemini or PayPal (Step 11: the hosted demo is a
// public link). Each visitor (by IP address) gets a number of requests per route in any 10 minutes.
// Over the limit, the route answers 200 with friendly words ({ notice }), never an error, so the browser
// shows no red console line. Kept in memory only: a restart starts everyone again (fine for a demo).
// The real cap on AI calls is still the daily counter (src/usage.js); this stops one visitor from
// hammering a route, e.g. a script or a stuck page.
const MINUTE = 60_000;
const WINDOW_MS = 10 * MINUTE;

// Per visitor, per route, in any 10 minutes. Chosen from how the page really uses each route:
// - parse: a person reads chats a few times (each real read can be up to 3 AI calls). Read without AI is
//   not limited (no AI call).
// - invoices: the page sends ONE request per buyer, so 50 buyers = 50 requests in a minute.
// - payment: recording cash / bank transfer, one click per buyer.
// - refresh: the page asks every 20 s (30 times in 10 minutes per open tab), so 2 tabs fit.
export const RATE_LIMITS = Object.freeze({
  parse: { limit: 6, windowMs: WINDOW_MS },
  invoices: { limit: 60, windowMs: WINDOW_MS },
  payment: { limit: 20, windowMs: WINDOW_MS },
  refresh: { limit: 60, windowMs: WINDOW_MS },
});

export const slowDown = (waitMs) => {
  const minutes = Math.max(1, Math.ceil(waitMs / MINUTE));
  return `You're going a bit fast for this free demo. Please try again in ${minutes === 1 ? "1 minute" : `${minutes} minutes`}.`;
};

// take(route, visitor) -> null (go ahead; the request is counted) or how many ms until the next one is allowed.
// maxVisitors keeps memory small: past it, visitors with nothing in the window are forgotten first, then
// the oldest ones.
export function createRateLimiter({ limits = RATE_LIMITS, now = Date.now, maxVisitors = 5000 } = {}) {
  const hits = new Map(); // "parse 203.0.113.7" -> times of the requests in the window, oldest first

  function forgetOld(t) {
    for (const [key, times] of hits) {
      const { windowMs } = limits[key.slice(0, key.indexOf(" "))];
      if (!times.length || times.at(-1) <= t - windowMs) hits.delete(key);
    }
    for (const key of hits.keys()) {
      if (hits.size <= maxVisitors) break;
      hits.delete(key);
    }
  }

  return {
    take(route, visitor) {
      const rule = limits[route];
      if (!rule) throw new Error(`No rate limit called "${route}".`);
      const t = now();
      const key = `${route} ${visitor ?? "unknown"}`;
      const times = (hits.get(key) ?? []).filter((at) => at > t - rule.windowMs);
      if (times.length >= rule.limit) {
        hits.set(key, times);
        return times[0] + rule.windowMs - t;
      }
      times.push(t);
      hits.delete(key); // re-insert, so the Map stays ordered from least to most recently seen
      hits.set(key, times);
      if (hits.size > maxVisitors) forgetOld(t);
      return null;
    },
    size: () => hits.size,
  };
}
