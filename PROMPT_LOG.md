# Prompt Log

| Date | Prompt summary | What happened | What I'd change next time |
|------|----------------|---------------|---------------------------|
| 2026-10-25 | Two small fixes: a Chat-date year rule, and expected-orders.json with the AI output field names | Fix B worked first time (7 orders / RM 387.00). Fix A's new rule still moved [29/10] silently to 2025; Claude flagged it and I replaced the rule with "nearest date + visible warning" | *(Claude's suggestion, rewrite in my words)* Ask for the test table first: the edge cases showed the problem before any code existed |
| 2026-10-25 | Step 1 in 6 parts, each with a CHECK; stop if a check fails twice; no features beyond Step 1 | All parts done, every check passed on the first try. 15 tests, and `npm run check` was proven to fail on a broken test. One value didn't match its goal: `engines ">=24"` lets Render pick a newer Node | *(Claude's suggestion, rewrite in my words)* Keep the parts + checks format. Keep giving the goal next to an exact value (as with engines), so Claude can check it against the docs |
