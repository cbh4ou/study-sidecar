# MVP v4.3 acceptance evidence

Audit date: 2026-10-26. Branch: `feat/mvp-v4.3`.

This is an evidence ledger, not a completion declaration. The specification in
[SPEC-v4.3.md](SPEC-v4.3.md) remains authoritative. A module test establishes the
behavior it exercises; it does not establish live microphone, global shortcut,
cloud provider, or complete browser behavior.

## Deterministic acceptance tests

Run the project gates from the feature checkout:

```sh
bun run check
bun run test
bun run typecheck
bun run --cwd apps/desktop build
```

| ID | Runnable evidence | What it establishes | Audit result |
| --- | --- | --- | --- |
| T1 | `bun test apps/daemon/src/lanes/packet.test.ts` | Fifty seeded randomized packets stay within 4,000 tokens; receipts, memory, anchors trim in order; stable system prefix; section redaction. | Existing deterministic tests. |
| T2 | `bun test apps/daemon/src/adapters/llm.test.ts apps/daemon/src/adapters/decide.test.ts apps/daemon/src/adapters/web.test.ts apps/daemon/src/graph/graph.test.ts` | Cloud lane messages/system strings, Jev inputs, web queries, and extraction prose are redacted at their boundaries. | Existing spies exercise adapter inputs. Native deep harness tool outputs and histories require the additional harness privacy tests. |
| T3 | `bun test apps/daemon/src/adapters/decide.test.ts apps/daemon/src/lanes/tools.test.ts apps/daemon/src/learn/learn.test.ts apps/daemon/src/graph/graph.test.ts` | A local-only source skips Jev/cloud Decide, private web work is rejected, anchored private lessons skip cloud recap, and private graph extraction is gated. | Module coverage exists. A complete cloud TurnRunner refusal regression was requested during this audit. |
| T4 | `bun test apps/daemon/src/adapters/decide.test.ts` | Low-confidence Jev escalates to LLM; Jev/LLM failures use rules; threshold is read from settings. | Existing deterministic tests. |
| T5 | `bun test apps/daemon/src/graph/graph.test.ts` | Invalid extractor replies retry with an actionable error; failed/aborted extractor or auditor changes no ledger; declared native submit_graph/submit_audit tool schemas, identity links, bounded read-only auditor operations, merge dedupe and simplification work. | Passed independently. |
| T6 | Same graph command | Node tombstones remove every referencing chain from the derived view; corrupt ledger lines are dropped. | Passed independently. |
| T7 | `bun test apps/daemon/src/learn/learn.test.ts` | A fixed-clock review log replays through ts-fsrs with fuzz disabled and yields deterministic due dates. | Passed independently. |
| T8 | Same learning command | Correct/partial/misconception/off-topic map to good/hard/again/again; explain-back evidence and voice reviews persist. | Passed independently. |
| T9 | `bun test apps/daemon/src/lanes/router.test.ts apps/daemon/src/adapters/decide.test.ts` | Rules and fake intent tables route stop to cancel and send-back language to bridge_back. | Existing deterministic tests. |
| T10 | `bun test apps/daemon/src/mvp-integration.test.ts bin/sidecar.test.ts` | The MCP tool result contains only status/ticket even when a fake daemon client returns an answer; the actual stdio server advertises both tools and tutor prompt. | Daemon integration adds a real authenticated ask acknowledgement; no answer in the HTTP result. |
| T11 | `bun test apps/desktop/src/lib/protocol.test.ts` | The desktop protocol matches generated canonical daemon output byte for byte. | Regenerate with `bun run gen-protocol` after canonical edits. |
| T12 | `bun test apps/daemon/src/mvp-integration.test.ts` | A real fake-mode daemon with isolated HOME and disabled Bun transpiler cache creates only the owned sidecar root in HOME. | This inventory is narrower than the requested filesystem spy: it does not detect arbitrary writes elsewhere in the filesystem. A process-wide write spy or syscall trace remains required for the exact criterion. |
| T13 | `uv run --project workers/voice-local --group test python -m pytest workers/voice-local/tests -q` | `test_t13_listen_stop_finalizes_without_waiting_for_silence` supplies only 100 ms of trailing silence and proves explicit stop finalizes. | Worker test exists; root runs the environment-specific pytest command. |
| T14 | `bun test apps/daemon/src/learn/learn.test.ts` | Plan parsing rejects cycles with line-numbered errors; statuses derive from tagged quiz answers; Measure requires three to six answered probes before planning. | Passed independently. |

The independent focused learning/graph run after the latest provenance regression
passed **46 tests**. The last independent full-suite snapshot before the remaining
parallel changes passed 262 tests and failed one CLI environment equality assertion:
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` was added to the daemon child but its expected
object had not yet been updated. The full TypeScript gate passed in that snapshot.
The integrator must replace these snapshot numbers with final integrated results.

## Phase acceptance

| Phase | Implemented path reviewed | Remaining acceptance work |
| --- | --- | --- |
| P1 | CLI fake flag and isolated root, fake LLM/Decide/web/voice, replay fixtures, telemetry route/ring, feature registration. | Final supervisor smoke run and all gates after integration. |
| P2 | Two Tauri windows, maximized Main, route tree/sidebar, graph/classroom/sessions/review/settings, Activity dock. | Browser verification of every route and native launch/hotkey behavior; cargo compilation alone does not prove global shortcut behavior. |
| P3 | PTT desktop/worker path, immediate finalization test, bounded packet, fast sentence chunking and interruption. | Browser fake press/release and actual local microphone/audio acceptance. |
| P4 | Decide composition, two parallel lanes, deep harness tools, async research acknowledgement/jobs. | Verify production lesson context contains learner answers, phase and source refs; fake-mode research/error jobs must be reachable without cloud calls. These gaps were sent to the lane implementer. |
| P5 | Durable lessons, question/answer transcript, three-to-six Measure guard, author-once DAG, plan statuses, fake ask/quiz/explain-back progression, active-lesson endpoint. | Render all phases and question kinds; verify the real model receives the recorded learner reasoning on continuation. |
| P6 | Extractor/auditor/merger, provenance-preserving graph ledgers, derived simplification, canvas/chains views. | Browser empty/populated/search/chain-overlay states and extraction after a full fake turn. |
| P7 | FSRS replay, button/voice grading, due count/cards, recap flushes graph first and creates only cards backed by real propositions. | Browser empty/populated review, badge and card states; idle/session-end recap flow. |
| P8 | Authenticated MCP, source flags and cloud gates, session binding, source tools, anchor confirmation, DND. | Browser pin-confirm and DND, full write spy, required README MCP/PDF instructions, live external adapter checks where credentials exist. |

## Integration findings and resolutions

- Confirmed anchors previously went only into the Sources rail while packets read
  `lesson.anchors`. `Learn.pinAnchor` now persists a deduplicated anchor, enforces
  the eight-anchor limit, and retains it in the Sources rail. The anchor feature
  must call this method after confirmation.
- Repeated claims originally failed to acquire the second session's provenance,
  and session paths were mislabeled as lesson references. The graph now appends
  source evidence for referenced/exact repeated claims and emits session refs for
  session JSONL batches. A regression proves one claim can retain two sessions.
- A stronger argument arriving after a weaker one left the old redundant chain
  visible. Snapshot derivation now simplifies the complete live argument set;
  append-only evidence remains intact.
- Local-only provenance now follows lesson anchors/sources through graph
  extraction, recap, graph tools and explain-back grading. Source indexing flags
  also apply to inherited refs.
- The audit found that the packet omitted actual learner reasoning, lesson phase
  and PDF/run/web source refs. These findings were handed to the lane implementer
  for the final integration. Without those fields the generic continuation turn
  cannot assess an answer that exists only in local lesson JSON.
- Both native windows originally subscribed to spoken answers, while global PTT
  always targeted Pill. The desktop implementer reports one audio owner and
  focused-Main PTT targeting, to be independently verified by the integrator.
- Background research must attach cited sources before appending tutor prose, so
  a threshold-triggered extraction cannot race ahead without citation provenance.
  This ordering issue was reported to the lane implementer.

## Material limits

No live Jev API-shape verification, live web-provider request, model teaching
quality evaluation, real microphone round trip, or native global-hotkey session
was established by this audit. PDF reading requires a local `pdftotext` executable
from Poppler. Fake mode must bypass that executable and GPU dependencies.

The specification explicitly permits manual DND as the fallback when operating
system screen-share/call detection is unavailable. That fallback must be documented
as manual behavior, not described as automatic detection.

The audit does not call the MVP accepted until the integrator closes the listed
integration gaps, reruns all required gates, and records browser/native evidence
and any remaining environment limitations.
