# AgentInspect Playground

Planning package for extending this demo into an AgentInspect consumer lab.

## Files in place

| File | Role |
| --- | --- |
| [`.cursor/agent-inspect-playground-plan.md`](../../.cursor/agent-inspect-playground-plan.md) | Master plan (P00–P12) |
| [`AgentInspect_Coverage_Seed.json`](./AgentInspect_Coverage_Seed.json) | Planned public-surface inventory (not executed evidence) |
| [`AgentInspect_Scenario_Catalog.json`](./AgentInspect_Scenario_Catalog.json) | 64 scenario families (planned) |
| [`baseline.md`](./baseline.md) | P00 baseline: app SHA, Node, pinned package versions |
| [`coverage-ledger.json`](./coverage-ledger.json) | Machine-readable coverage statuses |

## Commands

```bash
npm run lab:inventory   # regenerate inventory from installed packages
npm run lab:coverage    # print coverage summary from ledger
npm run lab:run -- --scenario S01 --profile offline
npm run lab:suite -- --suite travel-core
```

## Coverage statuses and regeneration

`lab:inventory` only *discovers* packages and symbols (`planned`, `implemented-unverified`, `unsupported`, `blocked`); export presence never yields a pass. Executed outcomes (`passed`, `failed`) are written by `lab:mark-m1-evidence` together with the input revision (agent-inspect version, lockfile integrity, package.json hash) and artifact links.

On regeneration the previous ledger is merged by row id:

- same revision and artifacts present: evidence and links are preserved;
- changed or unknown revision, or a missing artifact: the row becomes `stale`, keeping `lastExecutedStatus`, links and test ids;
- removed symbol: moved to `retiredSymbols` as `stale` (`symbol-removed`) with its evidence;
- `passed`/`failed` without links is rejected and recorded in `evidenceHistory`.

A corrupt or unexpected-schema ledger aborts regeneration instead of being overwritten.

Original demo commands (`demo:trip`, `/demo/ui`, etc.) remain unchanged.

Checksums in `SHA256SUMS.txt` verify the planning seed files only—not AgentInspect run evidence.
