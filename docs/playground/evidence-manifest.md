# Lab evidence manifest (`evidence.json`)

Each lab scenario run (success, returned failure, thrown, blocked) under `scripts/lab/run.ts` writes a local
AgentInspect **Evidence v1.0** manifest via `buildEvidenceManifest` from
`agent-inspect/advanced`.

- **Path:** `<artifactDir>/evidence.json` (last file written into the bundle)
- **Inputs registered:** `scenarioId`, `profileId`, `appGitSha`, `labArtifactDir`
- **Assessment:** `UNSAFE` / local-only — not share-checked or approved for external publication
- **Files hashed:** every other file in the bundle (closed file set; nothing is
  added after the manifest)
- **Identity:** the AgentInspect run id when a trace exists, otherwise the
  preallocated execution id (`inputs.identityKind`)
- **Provenance (full sha256, never truncated):** `lockfileSha256`,
  `appGitSha` + `appDirtyPatchSha256` when dirty, `scenarioSha256`,
  `oracleSha256`, `configSha256`, and the locked `agent-inspect` integrity,
  mirrored from `provenance.json` and cross-checked by the gate

## Bundle layout and harness gate

```text
artifacts/<batch>/<scenario>/<executionId>/            # native bundle (closed)
artifacts/<batch>/<scenario>/<executionId>.ancillary/  # SHA256SUMS.txt, bundle-verify.json
```

`SHA256SUMS.txt` and verification reports are ancillary and live outside the
bundle so hashes close without cycles. The harness gate runs the **default**
`agent-inspect bundle verify <dir> --json` (unexpected files fail; never
relaxed to warnings) plus a provenance consistency check. A failing gate turns
the returned scenario verdict into `fail` and `lab:mark-m1-evidence` refuses to
mark evidence.

Failure paths (`scripts/live-eval.ts` failures and thrown exceptions, lab
thrown errors) finalize the same kind of bundle with identity, trace when
available, oracle/proposal summary, and a bounded/redacted error. Packs stay
local/`UNSAFE`; nothing is share-checked.

Coverage is per runner: this gate covers `lab:run` (travel-core and other
suites that use `runScenario`) and live-eval failure packs. `lab:extended` and
`lab:cli` packs are not native bundles and a passing travel-core run does not
prove them. Offline fixture results and live provider evidence stay labeled
separately.

Regenerate inventory after dependency bumps:

```bash
npm run lab:inventory
```
