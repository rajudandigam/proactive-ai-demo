# AgentInspect Playground baseline (P00)

Generated: 2026-09-28T21:09:03.021Z

## Application

| Field | Value |
| --- | --- |
| Package | proactive-ai-demo@1.0.0 |
| Git SHA | `76d6d8f5e7f69412e5c53849a5c1516810b638fa` |
| package-lock agent-inspect | 6.31.15 |
| package-lock SHA-256 | `b4f8556d0029cdc970d6c427b105a59111de28668b12706abc9d03a904318b4b` |

## Environment

| Field | Value |
| --- | --- |
| Node | v22.22.3 |
| npm | 10.9.8 |
| OS | darwin/arm64 |

## AgentInspect pin

| Field | Value |
| --- | --- |
| Pin (package.json) | 6.31.15 |
| Installed | **6.31.15** |
| package-lock integrity | sha512-d7GmUzAM3+gcHzbAH0HVSL0uK2afbK+YGT4xV+QBMj5qXWDsKVHLEXF0I7AchuN/HuP9J4KbZ52fypkoPBA9vw== |
| npm dist.integrity (fallback) | sha512-d7GmUzAM3+gcHzbAH0HVSL0uK2afbK+YGT4xV+QBMj5qXWDsKVHLEXF0I7AchuN/HuP9J4KbZ52fypkoPBA9vw== |
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
