# Proactive AI Demo V2

Local NestJS + LangGraph demo for an **eight-minute talk**: one trip-attention agent, mock travel facts, optional live OpenAI tool loop, policy visibility, and a presentation UI.

> Mock travel data · Preview-only delivery · In-memory ledger (restart clears state) · No durable scheduling

## Quick start

```bash
npm ci
cp .env.example .env
# For stage: DECISION_PROVIDER=live and OPENAI_API_KEY=...
# For rehearsal without credits: leave DECISION_PROVIDER=fixture
npm run start:dev
```

Open **http://127.0.0.1:3000/demo/ui**

CLI (other terminal):

```bash
npm run demo:reset
npm run demo:trip
npm run demo:arrival
npm run demo:noimpact
npm run demo:flight
npm run demo:repeat
```

## Modes

| Mode | When | Label |
|------|------|--------|
| LIVE | `DECISION_PROVIDER=live` + API key | LIVE OPENAI |
| FIXTURE | default / rehearsal | FIXTURE (scripted agent tools; not live AI) |
| REPLAY | saved recording in UI | REPLAY |

## What the agent does

1. Policy binds allowed candidates, tools, and timing (Demo policy v2).
2. Optional path: model requests read tools (`read_trip_snapshot`, `read_weather_context`, `read_destination_impact`, `read_contact_history`).
3. LangGraph executes tools and returns results to the model.
4. Final structured decision set covers every eligible candidate.
5. Application validates and writes mock outbox previews.

Required flight alerts use an independent template path (no optional AI).

## Presets

| Preset | Scenario id |
|--------|-------------|
| Before departure | `jordan-before-departure` |
| Arrival route affected | `jordan-arrival-affected` |
| Arrival no journey impact | `jordan-arrival-unaffected` |
| Quiet hours | `jordan-quiet-hours` |
| Consent disabled | `jordan-consent-disabled` |
| Confirmed flight change | `jordan-flight-change` |

## Tests and live eval

```bash
npm run validate          # typecheck + tests + build (no OpenAI)
npm run demo:live-eval    # opt-in; requires DECISION_PROVIDER=live + key
```

Ordinary tests never call OpenAI. AgentInspect: set `AGENT_INSPECT=1`, then:

```bash
npx --no-install agent-inspect list --dir .agent-inspect
```

## Eight-minute stage script

| Time | Show | Say |
|------|------|-----|
| 0:00–0:50 | Architecture tab | Local app; fixtures for trip data; OpenAI for inference |
| 0:50–1:30 | Agent-loop diagram | Model asks for facts; LangGraph carries results and stops |
| 1:30–3:15 | Before-departure Run | Policy first, then tools, then proposal vs application result |
| 3:15–4:40 | Arrival affected | Does this change something Jordan should do? |
| 4:40–5:40 | No-impact compare | Same candidate type; journey differs → silence can be useful |
| 5:40–6:20 | Quiet hours | Model never called; planned wait |
| 6:20–7:05 | AgentInspect | Policy step, model calls, tools, outcome |
| 7:05–7:45 | Flight + Repeat | Required path; no second logical notification |
| 7:45–8:00 | Close | Model decides usefulness; application makes it dependable |

**Five-minute cut:** architecture glance → before-departure → one comparison → quiet hours or flight+repeat → close.

## Docs

- Spec: [docs/demo-v2-brief.md](docs/demo-v2-brief.md)
- Diagrams: [docs/architecture/](docs/architecture/)
- Runbook detail: [docs/RUNBOOK.md](docs/RUNBOOK.md)

## Known limitations

- In-memory outbox/ledger; process restart clears state
- Mock travel providers only
- Preview notifications only (no real push)
- Wait `recheckAt` is recorded, not scheduled by a worker
- Live model wording varies; evaluate actions/facts, not exact sentences
