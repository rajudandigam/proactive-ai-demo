# AgentInspect Playground baseline (P00)

Generated: 2026-09-26T19:11:02.348Z

## Application

| Field | Value |
| --- | --- |
| Package | proactive-ai-demo@1.0.0 |
| Git SHA | `5981a1bf0a81dfb576b8fbf14bd169737f0c24aa` |
| package-lock agent-inspect | 6.31.7 |
| package-lock SHA-256 | `e498bfba2ef95ce0c9f544db1e93ef14bc3c6deac1aee8ef807c1ede88732f27` |

## Environment

| Field | Value |
| --- | --- |
| Node | v22.22.3 |
| npm | 10.9.8 |
| OS | darwin/arm64 |

## AgentInspect pin

| Field | Value |
| --- | --- |
| Plan review baseline | 6.31.7 |
| Installed | **6.31.7** |
| npm dist.integrity (when reachable) | sha512-6TU0v/m4wscLaXhUfZPt07oJ+Efob0TdgCHxx2q7LHT6ekcxiHcW1sOtxrBxSwiqebeHAyqVu22Jbuc4Ujx1dA== |
| Core export subpaths | ., ./advanced, ./checks, ./diff, ./exporters, ./logs, ./persisted, ./readers, ./reporters, ./workspace, ./writers |
| Root runtime exports | 7 |
| CLI commands discovered | 38 |

## Inventory summary

| Metric | Count |
| --- | --- |
| Public packages (seed) | 18 |
| Installed in this app | 1 |
| Blocked (not installed) | 17 |
| Symbol/subpath/CLI rows | 55 |
| Implemented-unverified (M1 targets) | 6 |
| Passed (executed evidence) | 0 |

## Notes

- Seed file `AgentInspect_Coverage_Seed.json` remains planning data; this baseline and `coverage-ledger.json` are generated from the installed tarball.
- `@agent-inspect/langchain` peer requires `@langchain/core ^1.0.0`; this app stays on 0.3.x with **manual** instrumentation until an isolated P07 consumer.
- Existing offline validation: run `npm run validate` separately and record results in evidence manifests.

## Artifacts

- Coverage ledger: `docs/playground/coverage-ledger.json`
- Scenario catalog (planned): `docs/playground/AgentInspect_Scenario_Catalog.json`


## P03–P12 progress

- Extended offline suite `all-extended`: 13/13 pass (`batch-ext-1790450260214`)
- CLI suite: 11/11 pass
- Playground UI route `/playground/ui`
- Integration apps / MCP / Docker interop: **blocked** until isolated install or compose evidence (see CLOSURE.md)
