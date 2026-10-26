# MVP v4.3 acceptance evidence

Audit date: 2026-10-26. Branch: `feat/mvp-v4.3`.

This records the integrated implementation and its automated acceptance evidence. The specification in
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
| T2 | `bun test apps/daemon/src/adapters/llm.test.ts apps/daemon/src/adapters/decide.test.ts apps/daemon/src/adapters/web.test.ts apps/daemon/src/graph/graph.test.ts` | Cloud lane messages/system strings, Jev inputs, web queries, and extraction prose are redacted at their boundaries. | Existing spies exercise adapter inputs. Native harness regressions additionally cover tool output redaction, source-scoped histories and inherited source privacy. |
| T3 | `bun test apps/daemon/src/adapters/decide.test.ts apps/daemon/src/lanes/tools.test.ts apps/daemon/src/learn/learn.test.ts apps/daemon/src/graph/graph.test.ts` | A local-only source skips Jev/cloud Decide, private web work is rejected, anchored private lessons skip cloud recap, and private graph extraction is gated. | Module coverage exists. A complete cloud TurnRunner refusal regression verifies neither fast nor deep lanes receive local-only text. |
| T4 | `bun test apps/daemon/src/adapters/decide.test.ts` | Low-confidence Jev escalates to LLM; Jev/LLM failures use rules; threshold is read from settings. | Existing deterministic tests. |
| T5 | `bun test apps/daemon/src/graph/graph.test.ts` | Invalid extractor replies retry with an actionable error; failed/aborted extractor or auditor changes no ledger; declared native submit_graph/submit_audit tool schemas, identity links, bounded read-only auditor operations, merge dedupe and simplification work. | Passed independently. |
| T6 | Same graph command | Node tombstones remove every referencing chain from the derived view; corrupt ledger lines are dropped. | Passed independently. |
| T7 | `bun test apps/daemon/src/learn/learn.test.ts` | A fixed-clock review log replays through ts-fsrs with fuzz disabled and yields deterministic due dates. | Passed independently. |
| T8 | Same learning command | Correct/partial/misconception/off-topic map to good/hard/again/again; explain-back evidence and voice reviews persist. | Passed independently. |
| T9 | `bun test apps/daemon/src/lanes/router.test.ts apps/daemon/src/adapters/decide.test.ts` | Rules and fake intent tables route stop to cancel and send-back language to bridge_back. | Existing deterministic tests. |
| T10 | `bun test apps/daemon/src/mvp-integration.test.ts bin/sidecar.test.ts` | The MCP tool result contains only status/ticket even when a fake daemon client returns an answer; the actual stdio server advertises both tools and tutor prompt. | Daemon integration adds a real authenticated ask acknowledgement; no answer in the HTTP result. |
| T11 | `bun test apps/desktop/src/lib/protocol.test.ts` | The desktop protocol matches generated canonical daemon output byte for byte. | Regenerate with `bun run gen-protocol` after canonical edits. |
| T12 | `bun test apps/daemon/src/mvp-integration.test.ts` | A test-only preload spies on synchronous/asynchronous filesystem mutations and Bun.write during a real fake daemon session. Only SIDECAR_HOME writes are allowed; runtime transpiler caching is disabled. | Passes. A separate attempted external write is rejected by the spy; the session audit records only owned paths. |
| T13 | `uv run --project workers/voice-local --group test python -m pytest workers/voice-local/tests -q` | `test_t13_listen_stop_finalizes_without_waiting_for_silence` supplies only 100 ms of trailing silence and proves explicit stop finalizes. | Worker test exists; root runs the environment-specific pytest command. |
| T14 | `bun test apps/daemon/src/learn/learn.test.ts` | Plan parsing rejects cycles with line-numbered errors; statuses derive from tagged quiz answers; Measure requires three to six answered probes before planning. | Passed independently. |

Final integrated validation on 2026-10-26: **280 Bun tests pass, zero failures**
across 47 files; Biome checks 187 files; desktop and daemon TypeScript pass.
The local worker has **26 passing pytest tests**. The desktop production build
and native `cargo check` pass. Real Chromium acceptance passes on ports 4321
and 4327, including actual authenticated HTTP, daemon WebSocket, fake voice
WebSocket and first-audio telemetry. Diagram label containment and unique ids
also pass in Chromium.

## Phase acceptance

| Phase | Implemented path reviewed | Remaining acceptance work |
| --- | --- | --- |
| P1 | Ports/fakes, isolated fake launch, replay, telemetry. | Fake daemon integration and full browser flow pass. |
| P2 | Native Pill/Main windows, all routes, activity, native launch command. | Routes render in Chromium; native build and launcher help pass. |
| P3 | PTT, partial transcript, packet warming/cap, fast speech and sentence queue. | Worker finalization, voice unit tests and Chromium keyboard PTT pass. |
| P4 | Composed decisions, parallel deep tools, native submit/read tools, cancellation. | Adapter spies, faux native provider tools/cancellation and panel flow pass. |
| P5 | Durable Measure/Plan/Teach, question dock and explain-back. | Chromium completes all three phases and all question kinds; state derives from durable answers. |
| P6 | Graph extraction/auditor/merger, provenance, simplification, canvas/chains. | Invalid submission/retry/failure, cascade, cross-session provenance and empty/populated browser graph pass. |
| P7 | FSRS, voice/button grades, pill due cards, visible recap and shutdown flush. | Replay, grading, recap shutdown tests and empty/populated browser review/pill cards pass. |
| P8 | MCP, research/PDF/run tools, anchors, privacy, DND, hotkeys. | Stdio/HTTP MCP, cited research and abort/error jobs, anchor/DND browser states, privacy and write-spy tests pass. |

## Integration findings and resolutions

- Confirmed anchors previously went only into the Sources rail while packets read
  `lesson.anchors`. `Learn.pinAnchor` now persists a deduplicated anchor, enforces
  the eight-anchor limit, and retains it in the Sources rail. The anchor feature
  calls this method after confirmation.
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
  and PDF/run/web source refs. Packets now include those fields, and continuation prompts explicitly follow
  Measure/Plan/Teach with the learner's actual reasoning.
- Both native windows originally subscribed to spoken answers, while global PTT
  always targeted Pill. Native routing now chooses one capture owner, remembers it through release,
  and keeps a single speech owner. Chromium verifies the web PTT path; native
  compilation passes.
- Background research must attach cited sources before appending tutor prose, so
  a threshold-triggered extraction cannot race ahead without citation provenance.
  The integrated tools enforce this ordering.

## Code review pass (2026-10-26, follow-up)

A review of the integrated branch found and fixed:

- **Model-chosen file reads were unscoped.** `read_run_metrics` and `read_paper`
  accepted any absolute path, so a cloud model (or text injected through web
  research) could read files such as `~/.pi/agent/auth.json`; redaction only
  masks known token formats. Both tools now read only files inside the attached
  session's repository or the exact file/pdf/run paths the learner added to the
  active lesson, reject non-files, and cap reads at 64 MB. Regression:
  `lanes/tools.test.ts` ("file tools only read the attached repo...").
- **`web_fetch` could reach local services.** HTTPS-only was enforced, but
  loopback, private, link-local and single-label hosts were not refused, before
  or after redirects. `isPrivateHost` now blocks them. Regression:
  `adapters/web.test.ts`.
- **Pinned anchors were read whole on every turn.** The packet builder now reads
  at most 256 KB per anchor before skeleton extraction.
- **Intermittent `factory is undefined` page error.** Rsbuild lazily compiles
  dynamic imports in dev by default; `pele/lazy` loads diagram types that way and
  the pill and main windows can request the same chunk concurrently. Dev lazy
  compilation is now off (`rsbuild.config.ts`). This also affects `tauri dev`.
- **Stray `<script type="module" src="/src/main.tsx">`** (pre-existing Vite
  leftover) was shipped in `dist/index.html` and failed to load. Removed; Rsbuild
  injects the real bundle.
- **Fake answers echoed the whole context packet.** The fake LLM now echoes only
  the packet's `## Question` section ("Fake answer to: what is a channel ack.").
- **Browser acceptance races.** The script sampled DND visibility once instead
  of waiting, and pressed push-to-talk before the daemon socket connected. Both
  now wait on observable state. Three consecutive runs pass.

Validation after the review: 282 Bun tests pass, Biome and both TypeScript
projects are clean, the production build passes, 26 worker tests pass,
`cargo check`/`cargo test` pass, and `bun run test:browser` passes three runs in
a row. The OKF keyword-fallback timing test (median under 15 ms) is
machine-speed sensitive and failed intermittently on a slower container; it
predates this branch.

## Material limits

The Jev adapter was corrected to the documented System One Choice request and
response shape, verified against the [official API](https://docs.typesafe.ai/api/system-one)
and [Choice documentation](https://docs.typesafe.ai/primitives/choice) on 2026-10-26.
The request/response contract and redaction are covered by mocked HTTP tests.
No credentialed live Jev call, live web-provider request, model teaching
quality evaluation, real microphone round trip, or native global-hotkey session
was established by this audit. PDF reading requires a local `pdftotext` executable
from Poppler. Fake mode must bypass that executable and GPU dependencies.

The specification explicitly permits manual DND as the fallback when operating
system screen-share/call detection is unavailable. That fallback must be documented
as manual behavior, not described as automatic detection.

All specified deterministic acceptance criteria and fake browser flows are now
verified. Native compilation passes; real operating-system global shortcuts,
microphone/speaker hardware, authenticated cloud responses and teaching quality
remain environment-dependent live validation limits, not claims established by
these fake-mode tests.
