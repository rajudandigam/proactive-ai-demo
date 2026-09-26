# AgentInspect Playground closure report

Generated: 2026-09-26T21:32:14.136Z

## Versions

| Field | Value |
| --- | --- |
| App SHA | `679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9` |
| Node | v22.22.3 |
| agent-inspect | 6.31.7 |

## Coverage counts

```json
{
  "packagesTotal": 18,
  "packagesInstalled": 1,
  "packagesBlocked": 17,
  "symbolsTotal": 55,
  "symbolsPlanned": 48,
  "symbolsImplementedUnverified": 3,
  "symbolsPassed": 4,
  "executedEvidence": 24
}
```

## Blocked packages (not installed in root)

- **@agent-inspect/adapter-sdk**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/ai-sdk**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/circuit**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/eval**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/guardrails**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/harness**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/index-sqlite**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/jest**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/langchain**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/mcp**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/mcp-server**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/openai-agents**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/redact**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/studio**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/tui**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/viewer**: Not installed in this app; deferred to isolated consumer or later phase
- **@agent-inspect/vitest**: Not installed in this app; deferred to isolated consumer or later phase

## Lane status

- **travelCoreOffline**: see lab:suite travel-core
- **extendedOffline**: see lab:extended
- **cli**: see lab:cli
- **interopDocker**: blocked until docker compose --profile interop is executed and evidence retained
- **langgraphAdapter**: blocked — isolated integration-apps/langgraph requires core ^1
- **aiSdkAdapter**: blocked-until-install
- **openaiAgentsAdapter**: blocked-until-install
- **mcpPackages**: blocked — @agent-inspect/mcp not installed in root
- **liveProviders**: opt-in; record blocked when credentials/network unavailable

## Open defects

- **R-remaining-live**: Live trip agent not yet the default lab lane; use --profile live-model explicitly
- **R-remaining-city-agent**: City/evening/helpdesk still construct answers deterministically — need real model loop
- **R-remaining-adapters**: Framework adapter consumers remain scaffolds without executed capture evidence

## Remaining work

- Harness R1–R8 repairs landed; keep refusing empty suites and verifying checksums
- Bring existing live trip agent into lab with --profile live-model and independent oracles
- Complete one everyday city assistant with real tool/model loop
- Deepen HTTP reservation restart/reconcile campaign beyond S18
- Install and run integration-apps/* with matching peer locks (P07)
- Add @agent-inspect/mcp client/server consumers (P08)
- Execute Docker interop profile and retain OTLP loss ledger (P11)
- Browser smoke for /playground/ui and TUI PTY tests (P10 remainder)

## Commands

```bash
npm run validate
npm run lab:suite -- travel-core
npm run lab:extended -- --suite all-extended
npm run lab:cli
npm run lab:report
```

Demo UI: `/demo/ui` · Playground UI: `/playground/ui`
