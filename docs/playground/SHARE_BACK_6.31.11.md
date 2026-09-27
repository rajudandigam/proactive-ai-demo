# Share-back: AgentInspect consumer re-test after 6.31.11

**To:** AgentInspect product owner / maintainers  
**From:** Raju Dandigam (consumer playground)  
**Date:** 2026-09-27  
**Consumer repo:** https://github.com/rajudandigam/proactive-ai-demo  
**Commits:** harness trust fixes `a4c9768`; this bump follows on `main`  
**Library under test:** `agent-inspect@6.31.11` (previously validated against `6.31.7`)

---

## One-paragraph summary

We upgraded the NestJS + LangGraph trip-attention playground from **agent-inspect 6.31.7 → 6.31.11** and re-ran the full offline lab campaign plus live OpenAI evaluation. **All offline suites stayed green** (validate, travel-core 9/9, extended 13/13, CLI 11/11). **Capture fidelity and contract checks remained 9/9 on the live-model lab lane.** One live-eval repeat of before-departure failed with application `UNSUPPORTED_ACTION` (model proposal variance)—capture still ran. We did **not** observe an AgentInspect capture/contract regression in this consumer.

---

## What we are sharing

| Artifact | Location | Use |
| --- | --- | --- |
| This report | `docs/playground/SHARE_BACK_6.31.11.md` (also in evidence zip) | Narrative for maintainers |
| Prior review (R1–R10 harness false-greens) | `docs/playground/review-next-steps.md` | Context for why harness was repaired first |
| Secret-scrubbed evidence zip | `evidence-share/AgentInspect_Retest_6.31.11_2026-09-27.zip` | Traces, oracles, logs, live recording |
| Expanded folder (same contents) | `evidence-share/2026-09-27-after-6.31.11/` | Browse without unzipping |

**Not shared:** `.env`, API keys, or cloud credentials. Logs were scrubbed for `sk-` patterns.

---

## Results at a glance

### Offline (deterministic)

| Check | 6.31.7 pack | 6.31.11 re-test |
| --- | --- | --- |
| `npm run validate` | Pass | **Pass** (17 tests + lab typecheck + build) |
| travel-core `@offline` | 9/9 | **9/9** |
| extended (city/evening/orchestration/contracts/lifecycle) | 13/13 | **13/13** |
| CLI suite | 11/11 | **11/11** |
| Unknown suite | Exit 2 | **Exit 2** (still refuses empty green) |

### Strong API / evidence examples (still green on 6.31.11)

| Case | What it proves |
| --- | --- |
| **S41** | Programmatic `openTraceFile` + `evaluateTraceContract({ read }, contract)` with `rulesEvaluated=2` |
| **S42** | Readable missing-tool finding (`must-exist-tool`), not unreadable-trace / zero rules |
| **S34** | `createInspector({ writer })` — memory events=4, null no disk files, file writer reopenable |
| **S18** | HTTP hold with drop-after-commit; receipt authority; **exactly 1 commit** after retry |
| **S46** | Share redaction: canaries removed, `safeTokenCount` preserved |
| **S08** | Concurrent sessions → distinct traces + sessions |

### Live (OpenAI `gpt-4o-2024-08-06`)

| Check | 6.31.7 pack | 6.31.11 re-test |
| --- | --- | --- |
| `demo:live-eval -- --repeat` | 4/4 pass | **3/4 pass** |
| travel-core `@live-model` overall | 5/9 | **5/9** |
| capture fidelity on live lab | 9/9 | **9/9** |
| contract on live lab | 9/9 | **9/9** |

**Live-eval detail (6.31.11):**

1. before-departure — pass (liveAttempts=3, outbox=1)  
2. quiet-hours — pass (zero model calls)  
3. before-departure — **fail** · `validation_reject` / `UNSUPPORTED_ACTION` · model proposal rejected by app validator  
4. quiet-hours — pass  

Recording path inside the zip: `live/recordings/live-eval-1790535544336.json`

**Why live lab overall is 5/9:** S01/S02/S03/S08 scenarios still declare fixture expectations (`modelMode: fixture`, `exactFixtureInvocations: 1`). Under `--profile live-model` the app correctly uses live OpenAI, so **application** oracles fail while **capture + contract pass**. That is playground scenario/profile binding debt—not an AgentInspect capture failure.

---

## Feedback worth acting on (consumer → library)

These remain useful product/docs signals. They are **not** claimed as open library defects from this re-test:

1. **Document the contract API clearly** — `evaluateTraceContract({ read }, contract)` with `read` from `openTraceFile`. Wrong argument order previously hid behind CLI fallbacks in consumer harnesses.
2. **Document writer binding** — writers attach via `createInspector({ writer })`, not `inspectRun({ writer })`. Silent ignore of unsupported options is easy to misuse.
3. **Keep negative-check diagnostics explicit** — unreadable traces with `rulesEvaluated: 0` must never be marketed as “required tool missing” successes in examples.
4. **Consumer three-verdict framing works well** — application / capture fidelity / contract. Encourage examples that separate them.
5. **Live model variance is real** — same scenario can pass then fail on `UNSUPPORTED_ACTION`. Capture should stay rich enough that another engineer can see the rejected proposal without re-running.

---

## How to reproduce

```bash
git clone https://github.com/rajudandigam/proactive-ai-demo.git
cd proactive-ai-demo
npm ci
# Offline
npm run validate
node --import tsx scripts/lab/run.ts --suite travel-core --profile offline
node --import tsx scripts/lab/run-extended.ts --suite all-extended
node --import tsx scripts/lab/cli-suite.ts
# Live (requires OPENAI_API_KEY in .env; never commit .env)
DECISION_PROVIDER=live AGENT_INSPECT=1 npm run demo:live-eval -- --repeat
node --import tsx scripts/lab/run.ts --suite travel-core --profile live-model
```

---

## Ask of AgentInspect maintainers

1. Confirm whether 6.31.8–6.31.11 changes intended to address the consumer misuse patterns above (docs/examples vs runtime).  
2. If helpful, we can add a minimal isolated repro package that only exercises contract + writers + readers (no Nest).  
3. Next consumer work on our side: live-specific scenario expectations, then one everyday city assistant with a real model/tool loop—not more scaffold adapters.

---

## File checklist for email / chat attach

- [ ] `AgentInspect_Retest_6.31.11_2026-09-27.zip` (primary attachment)  
- [ ] This markdown (`SHARE_BACK_6.31.11.md`) pasted or attached  
- [ ] Optional: link to https://github.com/rajudandigam/proactive-ai-demo  
- [ ] Optional: prior review `review-next-steps.md` if they have not seen the R1–R10 harness findings  

**Suggested subject line:**  
`Consumer re-test: proactive-ai-demo on agent-inspect 6.31.11 — offline green; live capture OK; one model variance fail`
