# AgentInspect Playground: implementation review and real-run program

Prepared for Raju Dandigam · 26 September 2026

The playground is a useful consumer application and an offline smoke-test foundation. The next milestone should be **trusted evidence from one real agent workflow**, followed by targeted adapter and lifecycle coverage. Several current checks can report success without exercising or verifying the capability named by the test. Fix these before using the coverage ledger to guide an AgentInspect release.

No AgentInspect library defect was established by this review. The reproduced issues below are in the playground, its test harness, or its use of the library. Correct contract and writer APIs worked in isolated consumer probes. Those integration mistakes also provide useful feedback for AgentInspect documentation and examples.

## 1. Reviewed versions and executed checks

| Item | Exact baseline |
| --- | --- |
| Playground | [679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9](https://github.com/rajudandigam/proactive-ai-demo/tree/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9) |
| Previous playground | 5981a1bf0a81dfb576b8fbf14bd169737f0c24aa |
| AgentInspect source | [3c3cbeda9c41776e67d79b068b4e28437c28cb23](https://github.com/rajudandigam/agent-inspect/tree/3c3cbeda9c41776e67d79b068b4e28437c28cb23) |
| Installed consumer package | agent-inspect 6.31.7, from the app lockfile |
| Review runtime | Node 24.19.0, npm 11.9.0, Linux |
| Source access | GitHub snapshot; no local Git history or server-side secrets |

Installed with `npm ci --ignore-scripts --no-audit --no-fund`. No application source files were modified, and no changes were pushed.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| `npm run validate` | Pass: application typecheck, 15 behavior tests, build | Existing application checks pass |
| Travel-core suite | Reported 9/9 pass | Current travel assertions execute |
| Extended suite | Reported 13/13 pass | Current extended assertions execute; several are too weak |
| CLI suite | Reported 11/11 pass | Selected commands execute; this is not complete CLI coverage |
| Full project typecheck | Fail | Scripts/tests are excluded from the ordinary build typecheck |
| Typecheck with Node16 resolution and Vitest globals | Still fails | Real lab type errors remain after resolving configuration noise |
| Focused review probes | Reproduced parser, fidelity, contract, writer, and hash problems | Concrete lab defects described below |
| Unknown suite | Exit 0, total 0 | Empty selections can look successful |
| Live OpenAI / public APIs | Not executed | No OpenAI key or `.env` was available to this review |

This environment rejects the IPC listener opened by the `tsx` CLI. The three lab suites were therefore run using the same scripts through `node --import tsx`, which does not start that listener. This is an environment limitation, not a project defect. The supplied evidence retains both the original launcher errors and the successful loader executions.

The reviewed source snapshot has no Git metadata, so newly generated manifests record `unknown` for its local Git SHA. The snapshot revision is pinned in this report and in the evidence archive metadata. These review runs are not clean-checkout release evidence.

## 2. What is implemented, and what is still open

The full trip request now has an AgentInspect wrapper, including fixture, policy-only, required-alert, and duplicate paths. This is a meaningful improvement over tracing only the live agent loop. The repo also has provider classes, city/evening/helpdesk workloads, a conditional LangGraph, a reservation simulator, artifact output, a coverage ledger, and selected CLI checks.

The committed closure report lists **18 packages, 1 installed, 17 deferred/unexecuted, and 4 of 55 inventoried symbols passed**. These 55 rows combine root symbols, subpaths, and CLI entries; they are not a complete method inventory. There are 18 scenario JSON files and four additional extended checks implemented directly in the runner. This does not establish execution of the original 64 planned scenario families.

| Area | Current implementation | Next evidence needed |
| --- | --- | --- |
| Original trip agent | Real OpenAI tool loop exists | Bring live runs into the unified lab artifact/verdict format |
| Lab profiles | Travel runner forces fixture mode; `profileId` is unused | Enforce explicit model/tool profiles end to end |
| City/evening/helpdesk | Deterministic answer construction | Add a real bounded model/tool loop to one workload |
| City supervisor | Conditional graph and parallel provider functions | Actual child workflow execution if claiming delegation coverage |
| Reservation uncertainty | Direct `sim.hold()` with persisted JSON receipt | Real HTTP response loss, restart, reconciliation, and duplicate-write assertions |
| Framework adapters | Mostly package manifests | Compatible lockfiles, runnable consumers, captured and checked executions |
| Example plugin | Explicit placeholder | Actual adapter SDK registration, loading, and conformance tests |
| MCP | Deferred | Real client/server consumer exercises |
| Interop | Collector Compose configuration | Executed export/ingest/round-trip evidence with a loss ledger |
| Playground UI | Offline travel-only subprocess runner | Fix JSON parsing, use asynchronous execution, expose explicit modes |

Calling the new city planner with live tools would make real HTTP requests, but its response would still be assembled by code. That is a useful provider test, distinct from a live agent decision test.

## 3. Fix these findings first

### R1 — Contract tests can pass for the wrong reason

**Priority: P1 · Reproduced.**

In `scripts/lab/run-extended.ts:259`, S41 calls `evaluateTraceContract(contract, { events })`. The installed API requires `evaluateTraceContract({ read }, contract)`, where `read` is a normalized reader result. The call throws `Cannot read properties of undefined (reading 'runs')`; the runner catches it and invokes the CLI. S41 then reports pass with `detail: cli-fallback`, although the programmatic API was not successfully exercised. Its contract literal also supplies `id` and `version`, which are not fields in the installed `TraceContractInput` type.

S42 constructs invalid JSONL and regards any CLI exception as successful detection. Its actual CLI result was **exit 3, `AI_CHECK_TRACE_UNREADABLE`, `rulesEvaluated: 0`**. This does not prove the required-tool rule detected a missing tool.

Use the public API correctly:

```ts
import { openTraceFile } from 'agent-inspect/readers';
import { defineTraceContract, evaluateTraceContract } from 'agent-inspect/checks';

const read = await openTraceFile(tracePath);
const contract = defineTraceContract({ tools: { required: ['ping'] } });
const result = evaluateTraceContract({ read }, contract);
```

For the negative case, generate a readable completed run with a different tool, or mutate a valid trace while preserving its schema. Assert the exact expected rule finding, selected run, and nonempty rule execution. Keep unreadable-input testing as a separate case. Preserve stdout, stderr, exit code, and parsed diagnostics on failures; `run.ts` currently overlooks `err.stdout` in its error path.

### R2 — The writer smoke test does not exercise the selected writers

**Priority: P1 · Reproduced.**

`run-extended.ts:384,391,403` passes `writer` to `inspectRun`, whose installed options do not support it. The review observed **zero memory-writer events**, and a JSONL file was still written for the purported null-writer run. Yet S34 reports success.

Use `createInspector({ writer })`, its instance methods, and explicit flush/close:

```ts
const writer = memoryWriter();
const inspector = createInspector({ writer });
await inspector.run('writer-check', () =>
  inspector.tool('ping', async () => ({ ok: true })),
);
await inspector.flush();
const events = writer.getEvents();
await inspector.close();
```

A corrected consumer probe captured four events. Assert actual rows, IDs, terminal status, persistence, drop/error diagnostics, and absence of disk writes for null/memory configurations. An invocation without an exception is not sufficient writer evidence.

### R3 — Capture fidelity accepts text that is not a trace

**Priority: P1 · Reproduced.**

`src/playground/oracle.ts:221` uses substring checks. The text `runId policy_envelope` passed the S33 fidelity checker with a nonexistent mapped run ID. It is not JSONL and has no execution or terminal events. This reproduces a failure of the fidelity verdict itself; it does not claim the separate contract checker would accept that text.

Read traces through the public reader, inspect diagnostics, select the exact mapped run, and compare normalized facts with independently observed calls and receipts. Assert completion, relationships, tool names/arguments, physical call counts, statuses, and explicit unknown values. Missing or ambiguous evidence must remain insufficient/fail.

Also remove `findTraceFile` fallbacks that choose an arbitrary JSONL file when identity lookup fails. S08 currently checks only the first result of the parallel pair; verify both sessions and both traces, with different inputs and interleaved delays.

### R4 — Playground Run has a broken result parser

**Priority: P1 · Parser reproduced; browser interaction not executed.**

`src/playground/playground.controller.ts:101` parses `out.slice(out.lastIndexOf('{'))`. Successful results contain nested assertion objects, so this starts inside the result rather than at its root. Applying the same parser to an actual successful S01 result threw a JSON syntax error.

Use an asynchronous runner service or subprocess returning a dedicated JSON result file or one machine-readable output channel. Separate logs from results. Replace blocking `execFileSync`, validate scenario/profile requests, and return structured blocked/failure outcomes. Add an HTTP/browser smoke test once the environment supports listening sockets.

### R5 — Evidence hashes do not cover nested traces

**Priority: P1 · Reproduced.**

`src/playground/artifact-writer.ts:93` hashes only immediate files. Extended runs store their JSONL under `inspect-traces/` and receipts under `receipts-db/`. Changing a nested trace left the generated checksum map unchanged in the probe. Extended runs also do not produce the same manifest and three-verdict result structure as travel runs.

Use one artifact writer for every workload. Enumerate nested files with relative paths, include the exact trace/contract/oracle/receipt inputs to each verdict, finalize after handles are flushed and closed, and verify the exported bundle. Keep raw local records separate from reviewed shareable records. Do not call a file safe merely because its name ends in `.safe.json`.

### R6 — Normal validation excludes the lab's own type errors

**Priority: P1 · Reproduced.**

`tsconfig.build.json` excludes `scripts` and tests. Thus `npm run validate` succeeds while the testing code has incorrect contract arguments, unsupported writer options, narrow string inference errors, and inventory-status typing problems.

Add a dedicated typecheck for lab scripts and consumer apps using package-export-aware module resolution. Include it in CI. Resolve runtime API mistakes instead of hiding them with `as never`. The Node16-resolution probe still reported the contract and writer misuse after correcting the initial resolution/global-type noise.

### R7 — Coverage can become green without verified cases

**Priority: P1 · Empty-suite behavior reproduced; remaining logic source reviewed.**

An unknown suite exited successfully with `total: 0`. `mark-m1-evidence.ts` trusts `failed === 0` and marks a fixed list of methods/package passed without verifying the expected case set or individual evidence hashes. `combineVerdict` treats any failure as expected detection when `expectFailure` is true; it does not match `expectedFailureCode`, which the schema declares. `lab:report` includes a hardcoded empty defect list rather than an executed defect inventory.

Reject unknown/empty suites; require expected cases and specific assertion IDs. Separate raw contract status from the test assertion that an expected rejection occurred. A missing executable, reader error, wrong finding, or unrelated application failure must not satisfy a semantic negative test. Derive coverage from exact package/version/symbol assertions and verified artifacts. Treat deferred installation as planned work unless an actual external blocker was observed.

### R8 — Live evidence needs accurate identities and profiles

**Priority: P1 before live promotion · Source reviewed.**

`run.ts` always uses `OFFLINE_PROFILE`, configures `DECISION_PROVIDER=fixture`, and hardcodes `agentInspectVersion: '6.31.7'`. The committed closure report names the previous application SHA without recording the dirty code/patch that produced it. This weakens later version comparisons.

Record installed package versions/integrities, app commit, dirty state or source digest, lockfile digest, scenario and contract hashes, requested and actual model/tool modes, provider/model identities, and independent call receipts. Setting `.env` to live does not turn `lab:suite` into a live-model test today.

### R9 — The live hotel lookup uses the wrong OSM tag

**Priority: P2 before public-provider use · Source reviewed and checked against OSM documentation.**

`src/providers/index.ts:352` queries `amenity=hotel`; the documented hotel tag is [`tourism=hotel`](https://wiki.openstreetmap.org/wiki/Tag:tourism%3Dhotel). Support the intended node/way/relation shapes and use their centers where appropriate. Keep hotel locations separate from price/availability claims.

Provider classes accept optional abort signals, but workloads do not supply deadlines, and TTL metadata does not implement caching. Add actual bounded timeouts, validation of empty geocoding results and malformed responses, caching, limited retries for reads, and explicit 429 handling. Test these against local HTTP stubs before external services.

### R10 — Uncertain-write and redaction checks need stronger assertions

**Priority: P2 · Source reviewed; current canary redaction worked in the reviewed run.**

The reservation test calls `sim.hold()` directly; it does not use the available HTTP server's dropped-response behavior, restart a process, reconcile through a client, or attempt a retry. Its assertion allows `reservationCommits >= 1`, which would not catch duplicate commits. Extend this to exact receipt/commit counts and independently observed physical attempts.

The redaction check accepts an empty trace because no secret string is present. Require the expected trace and metadata-bearing event, preserved harmless metadata, removed canaries, and successful reader/bundle verification. The actual reviewed trace contained `[REDACTED]` values and `safeTokenCount: 3`; that positive observation should be asserted by the test.

## 4. Make one workload useful enough to run every day

Recommended first application: **a city/trip assistant that answers a real request, adjusts it after feedback, and can place only simulated holds.**

Example: “Plan an afternoon near my Boston hotel. I prefer vegetarian food and indoor options if it rains.” Follow with “Make it closer to the hotel” and “Hold the suggested table.”

The agent should request relevant facts, ask for location/date clarification when needed, cite source IDs, state unknown opening hours, and choose a bounded plan. Code controls tool access, call limits, validation, and approval for simulated writes. A follow-up creates another physical run in the same session. The model receives actual tool results and produces a structured proposal that influences the final answer.

Start with the existing trip agent's live path while repairing the lab. Then connect a city model/tool loop to the implemented providers. Weather/places/media reads alone do not demonstrate agent judgment; demonstrate which tool choices and synthesis decisions the model actually made.

| Execution profile | Model | Tool data | Main question |
| --- | --- | --- | --- |
| Offline | Scripted | Fixtures/local stub servers | Does the application and tracing behave deterministically? |
| Live model | OpenAI | Fixed reviewed responses | Does model variation preserve invariants and remain faithfully captured? |
| Live tools | Scripted | Real bounded read APIs | Are adapters, arguments, provenance, and errors correct? |
| Live full | OpenAI | Real read APIs, local simulated writes | Is the application useful under real conditions? |
| Recorded tools | Explicitly selected scripted/live model | Saved provider responses | Can a previously observed situation be reproduced? |
| Artifact review | None | None | Can another person inspect the saved evidence? |

For every profile, distinguish attempted calls, successful provider responses, model refusals, business failures, contract rejections, and transport errors. Never manufacture token usage or mark it zero when unavailable. Preserve decisions and bounded evidence; do not request or store hidden model reasoning.

## 5. Prioritized execution campaign

These are suggested initial sample sizes, not statistical proof of production reliability.

| Order | Work to run | Suggested starting sample | Completion evidence |
| --- | --- | --- | --- |
| A | Repair R1–R8; rerun existing suites plus deliberate harness faults | Every current case once, then focused fault variations | Exact expected findings; no zero-case passes; verified artifacts |
| B | Existing trip live-model lane with fixed tool data | 3 judgment cases × 10 physical runs; zero-model policy cases separately | Independent provider attempts equal traced attempts; acceptable decision invariants |
| C | City live-tools lane | A small manual sample across 3 cities/queries | Correct queries, current dates, provenance, bounded requests, explicit unknowns |
| D | City live-full + follow-up | 10–20 genuine tasks used by you | Human usefulness rating tied to run/session IDs |
| E | Local failures and concurrency | 20–50 controlled repetitions for ambiguous/concurrent paths | Exact side-effect counts and no cross-run contamination |
| F | Adapter and MCP consumers | Happy/failure/parallel/cancel cases per selected integration | Locked peer versions and verified semantic capture |
| G | Candidate AgentInspect version comparison | Same frozen corpus plus scripted recapture | Reviewed differences and minimal regressions for discrepancies |
| H | Independent users | 2–3 consenting developers with different projects | Installation/debugging feedback and a real retained workflow |

Cap live calls and tokens per run/batch, stop on repeated provider errors, and retain model/provider mode in every result. Repeated failure injection and load tests belong on local stubs. Do not load-test shared public API services.

The highest-value scenario variations are:

| Scenario | Independent ground truth | AgentInspect capability |
| --- | --- | --- |
| Quiet hours / consent disabled | Provider request count is zero | Honest zero-LLM path |
| Affected versus unaffected arrival | Fixed impact facts and acceptable decision sets | Actual model judgment and decision evidence |
| Two cities concurrently with different response delays | Two distinct provider journals and outputs | Async context, parentage, no contamination |
| Read timeout then recovery | Stub request IDs, status history, attempt order | Retry identity and recovered failures |
| Successful response containing `{ok:false}` | Business error plus successful transport | Business outcome separated from span completion |
| Write committed, connection lost | External receipt journal | Unknown completion preserved |
| Restart then reconcile same logical operation | One durable receipt across processes | Multiple executions, one operation, no extra commit |
| Cancel during streaming or tool read | Abort observer and no later outbox write | Lifecycle termination and late-event behavior |
| Writer overflow or failure | Injected sink behavior and diagnostics | Fail-open application behavior, honest loss reporting |
| Malformed/truncated/mixed-run trace | Validated corpus transformations | Reader diagnostics and insufficient evidence |
| Redaction plus useful nonsecret metadata | Known synthetic canaries | Privacy and diagnostic usefulness together |
| Deliberately wrong tool order or arguments | Versioned expected rule/finding | Contract detection quality |
| Export then reimport | Original semantic facts and mapping ledger | Identity/status preservation and declared losses |
| Tracing enabled versus disabled | Same outputs, effects, exceptions | Noninterference and measured overhead |

## 6. Every run should produce a reviewable evidence packet

Use the same schema for all workloads:

```text
manifest.json
scenario.json
input.safe.json
output.safe.json
provider-observations.jsonl
oracle.json
trace.safe.jsonl
diagnostics.json
contracts/resolved-contract.json
checks/result.json
checks/stdout.txt
checks/stderr.txt
receipts/...
result.json
SHA256SUMS.txt
```

Raw local traces may be retained separately. A shareable packet should include only explicitly selected, reviewed data and the tool's verified evidence bundle when available. Checksums should cover nested files; a checksum list alone does not establish privacy or semantic correctness.

Record three independent verdicts, plus an overall test verdict:

1. **Application behavior:** provider journals, outbox state, final response, receipts.
2. **Capture fidelity:** exact run IDs and logical operations compared with independent observations.
3. **Contract behavior:** the expected pass, exact violation, or insufficient-evidence result.

A deliberately invalid execution can have a failing raw contract result and a passing test assertion. Those two statuses must remain visible. An evaluator crash cannot satisfy an expected semantic violation.

Add a feedback record keyed to the packet digest: task, expected behavior, observed discrepancy, severity, suspected owner, reproducer, and whether the evidence was sufficient. Suggested owners: application, model, provider, harness, adapter, reader, contract engine, writer, exporter, documentation, or unknown.

## 7. Turn feedback into AgentInspect improvements

For each discrepancy:

1. Preserve the original execution and independent observations.
2. Confirm the application/provider behavior without interpreting the trace.
3. Identify whether instrumentation used the documented public API correctly.
4. Reduce to the smallest consumer reproduction and sanitized fixture.
5. Run it against the pinned baseline and a proposed fix in isolated consumers.
6. Add a regression to the owning library package only when the library's expected behavior is demonstrated to be wrong.
7. Verify the packed candidate package from this playground, then retain before/after evidence.

Use two distinct version comparisons: **evaluate identical frozen traces** to test readers/checks/exports, and **recapture identical scripted executions** to test writers/context/adapters. Repeating live model requests mixes model variation with library variation, so it is not a clean library A/B test.

Product feedback already suggested by this review:

- Publish typechecked NestJS consumer examples for whole-request capture, explicit writers, and `openTraceFile` → contract evaluation.
- Make the distinction between `inspectRun` and `createInspector({ writer })` easy to find.
- Show transport status, business outcome, and insufficient evidence in one practical example.
- Demonstrate exact semantic-negative tests rather than generic nonzero exit checks.
- Refresh adoption examples that still request 6.12.0 while the reviewed package is 6.31.7. The current [design-partner guide](https://github.com/rajudandigam/agent-inspect/blob/3c3cbeda9c41776e67d79b068b4e28437c28cb23/docs/DESIGN-PARTNER-GUIDE.md) has this older pin.

Prioritize library changes by reproducible incorrect behavior, data loss, false-green checks, and repeated user difficulty. More tool providers are useful only when they expose another needed behavior.

## 8. Collect human feedback as well as correctness evidence

Ask a developer unfamiliar with the code to use one saved trace to answer: what failed, which attempt changed state, whether another retry is safe, and which source supports the conclusion. Record time taken, incorrect conclusions, missing information, and whether they needed help from the maintainer.

For live task usefulness, capture a short rating and one reason: useful, partially useful, wrong, or insufficient information. Tie it to exact evidence. Evaluate factual support, completed intent, unnecessary calls, appropriate abstention, and whether the next action was clear.

Track:

- Missing/duplicate logical calls and cross-run identity mistakes against independent journals.
- False positives and false negatives on labeled contract cases.
- Capture overhead distributions on equivalent workloads, including disabled mode.
- Writer dropped events and shutdown-loss diagnostics.
- Time to first trace, time to diagnose a planted fault, and whether another developer can reproduce it.
- Useful-task rate and repeat usage, separated from trace/test success.

A good trace of an unhelpful answer is a capture success and a product failure. A useful answer with missing spans is an application success and a capture failure.

For broader integration confidence, start with the separate LangGraph 1.x adapter consumer and one MCP flow. Add AI SDK/OpenAI Agents after those have real cases and locked peers. Evaluate coexistence with a tracing tool you already use, such as Braintrust, in an authorized development workload; Collector/Phoenix or Langfuse can be separate later lanes. Specify whether testing dual instrumentation, export, or import. Measure duplicate spans, missing identities/statuses, context interference, and overhead. Merely starting a container does not establish interoperability.

## 9. Commands available today

On your normal local checkout:

```bash
npm ci
npm run validate
npm run lab:suite -- travel-core
npm run lab:extended -- --suite all-extended
npm run lab:cli
```

These reproduce the current smoke baseline, including the weak assertions described above. Do not interpret them as full feature conformance. Do not promote coverage through `lab:mark-m1-evidence` until R7 is fixed.

The existing live path can be used immediately with your server-side key in `.env`:

```bash
DECISION_PROVIDER=live AGENT_INSPECT=1 npm run demo:live-eval -- --repeat
```

Today this runs only before-departure and quiet-hours, twice each. Before-departure calls the model; quiet-hours should make no model calls. It writes its summary under `recordings/` and capture under the configured trace directory. It is useful initial live evidence, but it does not yet create the lab's complete verified packet or exercise live public providers.

## 10. Verbatim Cursor follow-up

Paste the following after saving this report as `docs/playground/review-next-steps.md`:

```text
Read docs/playground/review-next-steps.md and inspect the current checkout.
The review baseline is proactive-ai-demo 679fd82 and agent-inspect 6.31.7.
Verify the installed versions before changing code. If HEAD has moved,
reconcile each finding with the current implementation first.

The goal is trustworthy consumer evidence and a useful real agent workflow.
The existing suite passes are smoke evidence, not complete conformance.
Keep application, harness, provider, model, and library defects separate.
Preserve the current demo commands and never silently substitute fixtures
for a requested live profile.

Phase 1 — Repair the test harness and evidence gates.
1. Add lab/consumer typechecks with correct module resolution; fix type
   errors instead of using as-never to hide unsupported library options.
2. Correct programmatic contracts to use openTraceFile and
   evaluateTraceContract({ read }, contract). Remove automatic CLI fallback
   from programmatic conformance tests. Test the CLI independently.
3. Replace S42 with readable negative evidence and assert the exact rule
   finding. Add a separate unreadable-trace test. Capture stdout, stderr,
   process exit, diagnostics, findings, and rule executions on every path.
4. Exercise writers with createInspector({ writer }), instance methods,
   flush/close, event/content assertions, and diagnostics. Prove null and
   memory configurations do not create file traces.
5. Replace substring fidelity checks with public readers/TraceFacts plus
   independent provider/outbox/receipt evidence. Reject the review probe
   'runId policy_envelope'. Bind every trace to its exact execution.
6. Reject empty/unknown suites. Honor expectedFailureCode and expected case
   sets. Match specific findings rather than treating every exception as
   successful detection. Verify both concurrent results, not only the first.
7. Use one typed manifest/result/artifact pipeline for all workloads.
   Hash nested traces, receipts, resolved contracts, and independent journals.
   Record installed versions/integrities, source revision/dirty state or
   source digest, lockfile hash, and requested/actual execution modes.
8. Derive coverage from verified per-symbol assertion evidence. Never mark
   the entire package conformant because three root methods ran. A package
   install or manifest is not an executed integration. Derive defect reports
   from retained findings rather than a hardcoded empty array.

Exit: existing suites pass with stronger checks; malformed/missing evidence,
wrong findings, empty suites, and unrelated runner errors cannot turn green.
Keep these deliberate harness tests as small, meaningful regressions.

Phase 2 — Make the UI and profiles truthful.
Fix PlaygroundController's lastIndexOf('{') parsing and blocking process
execution. Use a shared async runner service or dedicated JSON result file.
Validate scenario/profile inputs. Show actual model mode, tool mode, package
version, three verdicts, and artifact identity. Add HTTP/browser smoke tests.
Implement explicit offline, live-model, live-tools, live-full, and
recorded-tools profiles; reject unsupported combinations. Artifact review
must not create or count a new physical run. Do not mutate process-wide
provider/trace configuration to configure concurrent requests.

Phase 3 — Bring the existing live trip agent into the lab.
Keep the server-side key out of artifacts. Add provider-boundary request
journals independent of AgentInspect, with IDs, attempt counts, response
status, available usage, and bounded metadata. Capture before-departure,
arrival affected/unaffected, quiet-hours, consent-disabled, required alert,
and duplicate cases through the same artifact/verdict pipeline.
Separate scripted-provider invocations from real LLM attempts. Accept
reasonable model decisions through invariant sets, not exact wording.
Use configured call/token/time budgets; fail or block explicitly when
credentials/provider access is unavailable. Test scripted failures first.
Do not claim live results until actual requests and artifacts exist.

Phase 4 — Complete one live city assistant.
Use the existing weather/places providers with a real bounded model/tool
loop and structured final proposal. Add a same-session follow-up. The
model's tool choices and returned proposal must affect the outcome.
Fix hotels to use tourism=hotel and handle intended OSM element shapes.
Add response/argument validation, empty geocoding handling, real deadlines,
abort propagation, cache implementation, bounded read recovery, and source
provenance. Exercise these with local HTTP stubs before public API calls.
Do not claim room availability, prices, opening hours, or reservations
without supporting data. Keep all write actions simulated.

Phase 5 — Exercise uncertainty and real adapters.
Call the reservation simulator over HTTP. Commit then drop the response;
persist receipts outside the agent; restart a worker; reconcile; and repeat
the logical operation. Assert exactly one receipt/commit, distinct physical
attempts, and a preserved unknown completion before reconciliation. Include
denied approval, cancellation, malformed responses, writer failures, and
concurrent distinct inputs. Use local services for faults and repetitions.
Implement the isolated compatible LangGraph adapter consumer with a lockfile
and real assertions; replace placeholder smoke commands. Add an MCP
client/server flow and then AI SDK/OpenAI Agents as separately validated
lanes. Installation alone must not advance coverage.

Phase 6 — Produce feedback and candidate-version evidence.
Add a task feedback record linked to the evidence digest. Record usefulness,
factual support, unnecessary actions, debugging time, and missing facts.
Build two version comparisons: frozen traces evaluated by each version, and
the same scripted application recaptured with each SDK. Keep live model
sampling separate. Package minimal reproductions for confirmed library
defects; do not work around a suspected library defect before preserving
the failing evidence. Verify proposed fixes against packed consumer packages.
Use actual CLI help/public APIs for bundles and verification.

For every phase report: changes, actual commands and exits, physical runs
by profile, independently checked outcomes, verified artifact locations,
confirmed app/harness defects, suspected library defects, and blocked or
unimplemented coverage. Do not report a later phase complete based on a
scaffold. Work through unblocked phases in validated chunks.
```

## 11. What would justify confidence in the next AgentInspect release

- A clean, typed consumer checkout reproduces all mandatory cases.
- Missing evidence, unrelated errors, and zero-case suites cannot pass.
- Exact physical calls and effects reconcile with capture for the supported lanes.
- Unknown completion and unknown usage remain explicit.
- Labeled negative cases detect their intended rule; valid cases avoid known false positives.
- Disabled tracing preserves application results and exceptions; overhead/loss is measured.
- Candidate packages pass the frozen corpus and scripted recapture comparison.
- Another developer can open a verified packet and diagnose at least one real issue without maintainer guidance.

The immediate sequence is R1–R8, then the existing trip live-model campaign, then one useful city assistant and the HTTP uncertainty scenario. This creates actionable evidence for improving the library while keeping the work small enough to finish and use.

## Source and evidence index

- [Playground closure report](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/docs/playground/reports/CLOSURE.md)
- [Travel runner](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/scripts/lab/run.ts)
- [Extended runner](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/scripts/lab/run-extended.ts)
- [Fidelity oracle](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/src/playground/oracle.ts)
- [Playground controller](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/src/playground/playground.controller.ts)
- [Artifact writer](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/src/playground/artifact-writer.ts)
- [Providers](https://github.com/rajudandigam/proactive-ai-demo/blob/679fd82ec37a8a1f39edd0c6fe03e9f8762e38e9/src/providers/index.ts)
- [AgentInspect trace contracts](https://github.com/rajudandigam/agent-inspect/blob/3c3cbeda9c41776e67d79b068b4e28437c28cb23/docs/TRACE-CONTRACTS.md)
- Companion `AgentInspect_Playground_Review_Evidence.zip`: executed suite outputs, produced artifacts, reproducer, focused probe results, provenance and checksum index. The archive contains offline fixtures and deliberately synthetic canary values, not live credentials.
