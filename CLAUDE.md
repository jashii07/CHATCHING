# ChatChing: read this first

At the start of EVERY session, before building anything:

1. Read `MY_RULES.md` (how we work, safety rules, Definition of done) and `PLAN.md` (Section 9 has today's step).
2. Check `git status` and `git log --oneline -5`.
3. Run `npm run check`.
4. Do NOT ask Jasper explain-back questions (rule changed 27 Oct 2026). Instead, when a step is done, write a short "what was built and why" summary into `LEARNING.md` yourself, marked "summary by Claude".
5. FEATURE FREEZE since Sat 7 Nov 2026 (tag `freeze-2026-11-08`): until submission, real bug fixes only. No features, no redesign. If unsure, ask Jasper (MY_RULES.md, PLAN.md Section 9).

`MY_RULES.md` and `PLAN.md` are the source of truth. If anything here disagrees with them, they win.

Never open, print or commit `.env`.

## Deploy steps

Render deploys `main` on every push (https://chatching.onrender.com/).

1. Raise the version in `package.json` (and `package-lock.json`) for any change worth seeing live: `/api/health` shows the version, not the commit.
2. `npm run check` passes, then push `main`.
3. Wait until `/api/health` shows the new version, then **check it again a few minutes later** (added 2 Nov). Trust the deploy only when both checks show the new version. One answer can come from the old instance still running during the switch.
4. Run `npm run ui-live` for changes that touch the flow. A pass proves the site worked at that moment, not that the deploy stayed.
