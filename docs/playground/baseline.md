# AgentInspect Playground baseline (P00)

Generated: 2026-09-27T19:16:37.346Z

## Application

| Field | Value |
| --- | --- |
| Package | proactive-ai-demo@1.0.0 |
| Git SHA | `a4c9768d3cb08d04d822db511b83036c42504186` |
| package-lock agent-inspect | 6.31.11 |
| package-lock SHA-256 | `4e45ec4afc1379e05a45396ba6ac767cdabbef6e70489272118455c8b6c05fce` |

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
| Installed | **6.31.11** |
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
