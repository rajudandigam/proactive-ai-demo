# Proactive AI Demo

Local NestJS + LangGraph demo for a five-minute talk: Jordan’s SFO→BOS trip. Shows **policy → evidence → judgment → validation**, with a mock notification outbox. The model never delivers; only validated application code writes the outbox.

**Default mode is FIXTURE** (no API key). Set `DECISION_PROVIDER=live` only when you want a real OpenAI Structured Outputs call.

> Process restart clears the in-memory ledger. This demo makes **no durable delivery guarantee**.

## Quick start

```bash
npm ci
cp .env.example .env
npm run start:dev
```

In another terminal:

```bash
npm run demo:reset
npm run demo:trip
npm run demo:flight
npm run demo:repeat
```

Or with curl:

```bash
curl -s http://127.0.0.1:3000/demo/intake \
  -H 'Content-Type: application/json' \
  --data-binary @fixtures/requests/trip-review.json
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run start:dev` | Local server on `127.0.0.1:3000` |
| `npm run demo:reset` | Clear ledger + reload fixtures |
| `npm run demo:trip` | Trip review (optional model / fixture proposal) |
| `npm run demo:flight` | Required confirmed flight-change alert |
| `npm run demo:repeat` | Same flight event again (dedupe) |
| `npm run validate` | typecheck + test + build |
| `npm run demo:live-eval` | Opt-in live OpenAI eval (spends credits) |

## Expected behavior

### Trip review (`jordan-before-departure`)

| Signal | Outcome | Why |
|--------|---------|-----|
| preparation + weather | `act_now` | One combined push from verified facts |
| road closure / route | `wait` | Arrival guidance not due until ~2h before arrival (`recheckAt` ~ 15:30 ET) |
| abandoned hotel search | `silent` | Hotel already booked |

Fixture mode produces one mock notification similar to:

> Your Boston trip is tomorrow. Check-in is open, and rain is expected. View your trip plan.

### Flight change (`jordan-flight-change`)

- Required alert path uses an approved template (no optional model judgment).
- Reads `flight-status-v2` from fixtures (does not trust the event’s claim alone).
- `demo:repeat` returns the prior result; no second logical outbox entry.

## Environment

| Variable | Default | Notes |
|----------|---------|-------|
| `DECISION_PROVIDER` | `fixture` | `live` requires `OPENAI_API_KEY` |
| `OPENAI_MODEL` | `gpt-4o-2024-08-06` | Must support Structured Outputs |
| `OPENAI_TIMEOUT_MS` | `15000` | One attempt; no hidden retries |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Localhost only |

## Common setup failures

| Symptom | Fix |
|---------|-----|
| `ECONNREFUSED` on demo scripts | Start `npm run start:dev` first |
| Live mode errors about API key | Set `OPENAI_API_KEY` in `.env`; keep it out of git |
| Model timeout / refusal | Run fails as **failure**, not successful silence; use fixture mode for the stage |
| Quiet hours / consent tests fail unexpectedly | Fixture clock is fixed to scenario `now`; quiet hours are 22:00–08:00 local |

## Five-minute presentation script

| Time | Show | Say |
|------|------|-----|
| 0:00–0:35 | Request + fixture summary | Same trip from the slides — which updates would you want? |
| 0:35–1:50 | `demo:trip` proposal vs outcomes | Model helps combine useful details; app already ruled out hotel search and set arrival wait |
| 1:50–2:40 | Notification + wait + silent | Four signals → one message, one future check, one never-send |
| 2:40–3:35 | `demo:flight` | Required alert with verified template, no optional AI wait |
| 3:35–4:05 | `demo:repeat` | Same request twice → same logical notification |
| 4:05–5:00 | Compact trace | Evidence, decision, delivery; production also needs schedules/restarts |

Pre-open terminals, enlarge the font, start the server before the talk. Prefer a recorded run if the API stalls; announce FIXTURE vs LIVE clearly.

## Architecture

See [`.cursor/development_guide.md`](.cursor/development_guide.md) for the full brief. Flow: intake → policy/dedupe → fixture evidence → model **or** required template → validation → mock outbox.

## License

MIT
