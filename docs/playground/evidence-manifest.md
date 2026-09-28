# Lab evidence manifest (`evidence.json`)

Each successful lab scenario run under `scripts/lab/run.ts` writes a local
AgentInspect **Evidence v1.0** manifest via `buildEvidenceManifest` from
`agent-inspect/advanced`.

- **Path:** `<artifactDir>/evidence.json` (generated before `SHA256SUMS.txt`)
- **Inputs registered:** `scenarioId`, `profileId`, `appGitSha`, `labArtifactDir`
- **Assessment:** `UNSAFE` / local-only — not share-checked or approved for external publication
- **Files hashed:** all artifact siblings except `evidence.json` and `SHA256SUMS.txt`

Regenerate inventory after dependency bumps:

```bash
npm run lab:inventory
```
