# Lean MVP v3.1 acceptance status

Checked on 2026-10-21 against the eight gates in the product spec. A feature is marked partial when the behavior exists but a numeric target or integration has not been demonstrated.

| Gate | Status | Evidence and remaining work |
| --- | --- | --- |
| 1. Harness isolation | Partial | `apps/daemon/src/ingest/` tails Pi, OMP, Claude, and Codex JSONL read-only; Hermes uses a read-only SQLite connection. The tutor opens only `~/.study-sidecar/tutor.sqlite`. Hermes SQLite WAL readers may coordinate through shared-memory files, so the literal zero-lock condition cannot be guaranteed. |
| 2. Tool and skill loop | Partial | `apps/daemon/src/tutor/harness.ts` registers six scoped tools and loads bundled and user `SKILL.md` files. `skills/visual-pedagogy/SKILL.md` ships. The named external Obsidian, OKF, and NotebookLM skills are not bundled or validated end to end. |
| 3. Sieve and dead air | Partial | `apps/daemon/src/sieve/` has deterministic receipts, diffs, Bash tails, guardrails, and dead-air tests. The Tier-0 200 KiB receipt benchmark passes its 5 ms median threshold. Latency across each live harness has not been measured. |
| 4. Durable state | Verified in automated tests | `apps/daemon/src/tutor/harness.ts` uses Pi Durable compaction and typed documents. `apps/daemon/src/tutor/harness.test.ts` covers persistence, document commits, and concurrent requests. The small `slice(-10)` window in the system section is recent observed context, not the stored transcript. |
| 5. Visual diagrams | Partial | `apps/desktop/src/components/ui/mermaid-view.tsx` renders Pele diagrams and `MentorHud.tsx` links nodes to trace/diff context. The claimed sub-0.3 ms render time has not been benchmarked on the desktop WebView. |
| 6. Duplex voice | Partial | `workers/voice-local/` supports Silero, faster-whisper, Kokoro, interruption, and a tested daemon WebSocket proxy. CUDA Whisper and CPU Kokoro coexist on the RTX 4060. Both on CUDA exhausted its 8 GB VRAM. Warm short-sentence Kokoro synthesis measured 0.81 s, above the 40 ms first-audio target. OpenAI Realtime has protocol tests but no live API acceptance run. |
| 7. Modes and quizzes | Verified in automated tests | `modes/` ships spotter, co-pilot, and socratic. The daemon loads user modes; the HUD renders interactive quiz documents and mode controls. |
| 8. OKF and QMD | Partial | `apps/daemon/src/memory/` writes OKF Markdown with restrictive file modes and scopes collection names by root. The keyword fallback passes its bounded benchmark. QMD itself is not installed on the test machine, so hybrid retrieval and the 15 ms QMD target remain unverified. |

The combined 55 MB RAM target fails in the current development run: the Bun daemon used about 82 MB RSS, and the local Python voice worker used about 1.25 GB RSS after synthesis. The Rsbuild dev server used another 405 MB RSS. A production Tauri measurement is still needed, but it cannot make the already measured daemon and worker fit the target.
