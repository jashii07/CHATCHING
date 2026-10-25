# Decisions

| Date | Decision | My reason | Alternatives |
|------|----------|-----------|--------------|
| 2026-10-25 | Join PayPal AI Hackathon | My goal is experience: learn to direct AI and practise vibe coding; prizes are a bonus | Plan B: HackOnVibe + next Orchestrate |
| 2026-10-25 | AI model at runtime: Gemini free tier (candidate, not final) | Both models are free, but 3.6-flash answered every time in my test while 3.8-flash was overloaded, so I picked the one that is free AND reliable. (Earlier: free, no billing set up, judges can use the demo without me paying.) | Groq free tier, Claude API (paid) |
| 2026-10-25 | App idea: Chat-to-Checkout | My seller friend tracks chat orders in Excel by hand and chases payments one by one, so the problem is real. It also fits AI-in-batches (20 calls/day), an AG Grid table and PayPal invoices | Club treasurer copilot, split-bill agent, subscription watchdog, freelancer invoice chaser |

## AI model limits (checked 2026-10-25)

Gemini free tier (from my Google AI Studio rate-limit page):

| Model | Requests/minute | Requests/day | Tokens/minute |
|-------|-----------------|--------------|---------------|
| gemini-3.6-flash | 5 | 20 | 250K |
| gemini-3.8-flash | 5 | 20 | 250K |

Groq (backup candidate): free-tier limits NOT confirmed. The official rate-limits page (https://console.groq.com/docs/rate-limits) shows e.g. `openai/gpt-oss-20b` at 30 RPM / 1K RPD, but says these are "the base limits for the Developer plan" (paid). Real free limits only show in the Groq console after sign-up.

## Known weaknesses

- Gemini free tier is not reliable on 2026-10-25: `gemini-3.8-flash` gave 503 "high demand" and once took 147s; `gemini-3.6-flash` took 3.5s-20s. Google says free limits are "not guaranteed" and only shows them in AI Studio. The app will need a timeout, a retry, and a friendly fallback message.
- Only ~20 AI calls/day per model on the Gemini free tier, shared by me and the judges. Planned answers:
  - Batch AI work into few calls.
  - Cache every AI result.
  - Preload demo data with saved AI results.
  - A mock-AI mode for development, so building doesn't use up quota.
  - A non-AI fallback when the quota runs out.
