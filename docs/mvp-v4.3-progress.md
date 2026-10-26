# MVP v4.3 implementation checklist

Branch: `feat/mvp-v4.3`.
Persistent checkout: `/home/cbh4ou/projects/study-sidecar-mvp-v43`.
The original `study-sidecar` checkout on `main`, including its uncommitted v4
work, is preserved. An earlier temporary checkout was lost during an environment
reset; all recovered implementation is now committed in this persistent checkout.

| Phase | Dependencies | Status and integrated deliverables |
| --- | --- | --- |
| P1 | none | Implemented and verified: effect ports/fakes, fake CLI/replay, telemetry. |
| P2 | P1 | Implemented and verified: native Pill/Main windows, full Main routes, navigation and Activity dock. `--with-desktop` launches Tauri. |
| P3 | P1/P2 | Implemented and verified: global hold PTT, immediate worker finalization, capped warm packets, short fast replies and queued sentence TTS. |
| P4 | P3 | Implemented and verified: Jev/LLM/rules composition, intent/lane routing, parallel durable deep lane, native tools and cancellation. |
| P5 | P4 | Implemented and verified: durable lessons, Measure probes, author-once DAG plans, question dock, explain-back and source rails. |
| P6 | P4/P5 | Implemented and verified: extraction/auditor/merger, native read-only audit tools, append-only graph ledgers, canvas, search and chains. |
| P7 | P5/P6 | Implemented and verified: FSRS log replay, voice/button grading, due badge and pill cards, visible session recap and shutdown flush. |
| P8 | P4–P7 | Implemented and verified: MCP stdio tools/prompt, cited research/PDF/run tools, pin confirmation, privacy/indexing, DND and configurable shortcuts. |

Final integrated validation on 2026-10-26:

- `bun run check`: passes, 187 files.
- `bun run typecheck`: desktop and daemon pass.
- `bun run test`: 280 tests pass, zero failures, 47 files.
- Worker pytest: 26 tests pass.
- Desktop production build and native `cargo check`: pass.
- `bun run test:browser`: real Chromium passes all three lesson phases, all
  question kinds, voice/button review, graph/chains, source privacy, research
  running/abort/error/completion, pill PTT/card/anchor/DND/expansion and telemetry.
- The browser flow also passes with `SIDECAR_TEST_PORT=4327`, exercising
  configurable HTTP, WebSocket and voice discovery endpoints.
- `bun scripts/verify-diagram.ts`: label containment and unique diagram ids pass.
- Full fake daemon filesystem spy rejects writes outside its sidecar root; a
  negative test proves the spy detects attempted external writes.

See [mvp-v4.3-acceptance.md](mvp-v4.3-acceptance.md) for T1–T14 evidence and
external-service/hardware validation limits. No known critical integration
failures remain in the automated acceptance scope.
