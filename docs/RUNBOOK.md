# Presentation runbook (Demo V2)

## Before the talk

1. `npm ci && cp .env.example .env`
2. Set `DECISION_PROVIDER=live`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4o-2024-08-06`
3. Optionally `AGENT_INSPECT=1`
4. `npm run start:dev`
5. Open http://127.0.0.1:3000/demo/ui — enlarge browser text
6. Warm-up: Run before-departure once; confirm LIVE OPENAI badge
7. Keep a FIXTURE recording / prior successful screenshot as fallback
8. `npm run demo:reset` for a clean ledger

## Commands

| Goal | Command / UI |
|------|----------------|
| UI | http://127.0.0.1:3000/demo/ui |
| Trip review | Scenario “Before departure” → Run |
| Arrival impact | “Arrival — route affected” → Run (new session) |
| No impact | “Arrival — no journey impact” → Run (new session) |
| Quiet hours | “Quiet hours” → Run |
| Flight alert | “Confirmed flight change” → Run |
| Dedupe | Repeat same event |
| CLI parity | `npm run demo:trip` etc. |
| Live eval | `npm run demo:live-eval` |

## Honesty labels

- Always announce LIVE vs FIXTURE vs REPLAY
- Fixture agent tool transcripts are deterministic demos, not OpenAI
- Required alerts are application/template, not optional AI

## Fallback (5 minutes)

Architecture → one live/fixture before-departure → completed impact vs no-impact → flight+repeat → return to slides.
