# MVP v4.3 execution checklist

Branch: `feat/mvp-v4.3`.
Persistent checkout: `/home/cbh4ou/projects/study-sidecar-mvp-v43`.
Original main checkout and local v4 edits are preserved.

An environment reset removed the earlier `/tmp` checkout and its uncommitted
integration work. This persistent checkout recovers from remote commit 5160e90.
Previously measured checks must be rerun after rebuilding integration.

| Phase | Owner | Dependencies | Status |
| --- | --- | --- | --- |
| P1 ports/fakes/telemetry/CLI | lanes + root | none | Audit/recovery |
| P2 windows/routes/activity | desktop | protocol | Recovery |
| P3 PTT/packet/fast lane/TTS | lanes + desktop | P1 | Recovery |
| P4 Decide/deep/research/tools | lanes | learning services | Recovery |
| P5 lessons/Measure/Plan/questions | learning | P1 | Recovery |
| P6 extraction/graph/views | learning + desktop | P1 | Recovery |
| P7 FSRS/review/recap | learning + desktop | P5/P6 | Recovery |
| P8 privacy/sessions/MCP/anchors/settings | root | features | Recovery |
| T1-T14, full checks/build/browser/native | root | integration | Pending |

Commit coherent changes incrementally so subsequent environment resets preserve
work. Every agent uses this feature checkout exclusively.
