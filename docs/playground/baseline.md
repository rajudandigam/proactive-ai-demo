# AgentInspect Playground baseline (P00)

Generated: 2026-09-28T22:56:20.110Z

## Application

| Field | Value |
| --- | --- |
| Package | proactive-ai-demo@1.0.0 |
| Git SHA | `02e62dd15c25dbe5a42ac70aef24c0a4dafea0c0` |
| package-lock agent-inspect | 6.31.16 |
| package-lock SHA-256 | `aa9e9ab656990838fd9c38ea20dd16867769660f4b68d96395f632c2099455cc` |

## Environment

| Field | Value |
| --- | --- |
| Node | v22.22.3 |
| npm | 10.9.8 |
| OS | darwin/arm64 |

## AgentInspect pin

| Field | Value |
| --- | --- |
| Pin (package.json) | 6.31.16 |
| Installed | **6.31.16** |
| package-lock integrity | sha512-k8rCmlH6v8v492VtkNmaWseK4zSTEiZDmlvM185X2uqPjNTPiN7JCPhZrELPxkDN/jC8ci/HgbxZHl+GI3FboQ== |
| npm dist.integrity (fallback) | sha512-k8rCmlH6v8v492VtkNmaWseK4zSTEiZDmlvM185X2uqPjNTPiN7JCPhZrELPxkDN/jC8ci/HgbxZHl+GI3FboQ== |
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
