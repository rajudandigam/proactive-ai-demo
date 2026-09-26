# AgentInspect Playground closure report

Generated: 2026-09-26T19:59:11.948Z

## Versions

| Field | Value |
| --- | --- |
| App SHA | `5981a1bf0a81dfb576b8fbf14bd169737f0c24aa` |
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
  "executedEvidence": 16
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

## Remaining work

- Install and run integration-apps/* with matching peer locks (P07)
- Add @agent-inspect/mcp client/server consumers (P08)
- Execute Docker interop profile and retain OTLP loss ledger (P11)
- Expand contract rule-family matrix beyond S41/S42 (P05 remainder)
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
