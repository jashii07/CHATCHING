# Decisions

| Date | Decision | My reason | Alternatives |
|------|----------|-----------|--------------|
| 2026-10-25 | Join PayPal AI Hackathon | My goal is experience: learn to direct AI and practise vibe coding; prizes are a bonus | Plan B: HackOnVibe + next Orchestrate |
| 2026-10-25 | AI model at runtime: Gemini free tier (candidate, not final) | free, no billing set up, judges can use the demo without me paying | Groq free tier, Claude API (paid) |

## Known weaknesses

- Gemini free tier is not reliable on 2026-10-25: `gemini-3.8-flash` gave 503 "high demand" and once took 147s; `gemini-3.6-flash` took 3.5s-20s. Google says free limits are "not guaranteed" and only shows them in AI Studio. The app will need a timeout, a retry, and a friendly fallback message.
