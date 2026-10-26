# Implementation brief for workstream agents (SPEC v4.3)

Source of truth: `docs/SPEC-v4.3.md`. Read it plus this brief before coding.

## Ground rules

- Work ONLY in the files your workstream owns (listed in your task). If you need a change in a file you do not own (protocol.ts, index.ts, features.ts, services.ts, feature.ts, settings.ts, package.json, ws.tsx, api.ts, another workstream's files), do NOT edit it: describe the exact change in your final report.
- Do NOT run `bun add` / `bun install` / modify package.json or bun.lock. Already installed: daemon `zod`, `ts-fsrs`, `@modelcontextprotocol/sdk`, `@earendil-works/pi-ai`, `pi-durable`; desktop `d3-force`, `d3-zoom`, `d3-selection` (+ @types), react 19, @tanstack/react-query + react-router, streamdown (+ @streamdown/math, mermaid), pele, lucide-react, motion. Ask in your report if you truly need another.
- Never edit `apps/desktop/src/components/ui/` or `apps/desktop/src/components/ai-elements/` (vendored).
- `apps/daemon/src/protocol.ts` is canonical; the desktop copy is generated. You may IMPORT its types everywhere.
- Every external effect goes through a port (`apps/daemon/src/ports/*.ts`). Tests use fakes; NO network, NO real model calls, NO GPU.
- Filesystem: everything the sidecar writes lives under `sidecarHome()` (`apps/daemon/src/paths.ts`; `SIDECAR_HOME` env overrides it). In tests set `process.env.SIDECAR_HOME` to a `mkdtemp` dir or pass a root explicitly. Use `writePrivateFile`, `appendJsonLine`, `readJsonLines`, `ensurePrivateDir` (0700 dirs / 0600 files). Never write inside watched session dirs or repos.
- No em-dashes in user-facing copy.
- Style: Biome (tabs, double quotes). Before finishing run on YOUR files only:
  - `bunx biome check --write <your files>` then `bunx biome check <your files>` (must be clean)
  - `bun test <your test files>` (must pass)
  - `bun run typecheck` (whole repo: desktop tsc + daemon tsc). If it fails ONLY because of another workstream's in-progress files, say so; your files must be clean.
- Other agents are editing other files in this same checkout concurrently. Do not run `git commit`, `git stash`, `git checkout`, or anything that touches other files. Do not delete files you do not own.

## Daemon architecture (already in place)

- `feature.ts`: `Feature` interface (`route`, `onClientMessage`, `onEvent`, `onConnect`, `start`, `stop`) and `DaemonContext` (`root`, `fake`, `broadcast`, `ports {llm, decide, web, clock}`, `settings`, `activity`, `services`, `tutor`, `events()`, `session()`, `watchedPath()`, `ingestEvent()`), helpers `json(data, cors, status)` and `readBody(request)`.
  - Daemon features export a factory `createXFeature(context: DaemonContext): Feature`. The integrator registers it in `features.ts`.
  - Routes: auth/CORS/host are already checked; return `json(..., cors)` or `undefined` if the path is not yours.
  - `onClientMessage` receives parsed `ClientMessage`; return `true` when you handled it.
- `services.ts`: cross-feature service interfaces (`GraphService`, `LearnService`, `PrivacyGate`, `SessionsService`, `TelemetryRecorder`). Your feature registers its service in `start()` or the factory: `context.services.graph = ...`. Consumers must tolerate a missing service.
- `activity.ts`: `context.activity.start(kind, label)` returns a handle with `signal`, `update`, `finish`.
- `settings.ts`: `context.settings.value` (StoredSettings, includes secrets), `.update(patch)`, `.public()`.
- `ports/decide.ts`: `DecidePort`, `DECIDE_OPTIONS`, `certain()`.
- `ports/llm.ts`: `LlmPort` (`stream`, `complete({json})`, `isCloud`). `ports/web.ts`: `WebSearchPort`. `ports/clock.ts`: `Clock`, `systemClock`, `FakeClock`.
- `tool-spec.ts`: `ToolSpec` + `Type` for deep-lane tools contributed by features (integrator wires them into the pi-durable harness).
- Redaction: `tutor/redact.ts` `redact(text)`.

## REST contract (daemon implements, desktop `apps/desktop/src/lib/api.ts` consumes)

| Route | Owner | Response |
|---|---|---|
| `GET /api/graph` | C | `GraphSnapshot` |
| `DELETE /api/graph/nodes/:id` | C | `{ deleted: string, chainsRemoved: string[] }` |
| `GET /api/lessons` | D | `{ lessons: Lesson[] }` (newest first) |
| `POST /api/lessons` `{goal, title?, anchors?, sessionPath?}` | D | `{ lesson: Lesson }` |
| `GET /api/lessons/:id` | D | `LessonDetail` |
| `POST /api/lessons/:id/sources` `{source: SourceRef}` | D | `LessonDetail` |
| `GET /api/cards/due` | D | `{ cards: Card[] }` |
| `GET /api/sessions` | E | `{ sessions: SessionSummary[], follow: boolean, bound: string \| null, acrossSessions: Array<{id, name, sessions: string[]}> }` |
| `GET /api/sessions/detail?path=` | E | `SessionDetail` |
| `GET /api/sources`, `POST /api/sources` `{path, local_only?, index_graph?}` | E | `{ sources: Record<path,{local_only, index_graph}> }` / `{ ok: true }` |
| `GET /api/settings`, `POST /api/settings` (SettingsPatch + `decide.jevApiKey`, `web.apiKey`) | E | `SidecarSettings` (no secrets) |
| `GET /api/telemetry` | A | `{ turns: TelemetryEntry[] }` (newest last, max 50) |
| `GET /voice` (existing) + `engines?: {stt: string[], tts: string[]}` | F | |

All wire types live in `protocol.ts`.

## WebSocket contract

Daemon -> client additions: `turn_started`, `transcript`, `fast_answer` (one sentence per message, client appends + speaks), `deep_update`, `turn_settled`, `question`, `cards_due`, `card_prompt`, `anchor_suggest`, `graph_changed`, `lessons_changed`, `sessions_changed`, `bound_session`, `activity`.
Client -> daemon additions: `question {text, source?, lessonId?, sttMs?}`, `ptt_start`, `ptt_stop`, `interrupt`, `answer`, `grade`, `anchor_confirm`, `bind_session`, `dnd`, `abort_job` (index.ts handles abort_job).

PTT flow: desktop on Alt+Space press sends `ptt_start` (daemon ws) + `listen_start` (voice ws); on release `listen_stop` (voice ws) + `ptt_stop` (daemon ws). The worker returns the final `transcript` on the voice ws; the desktop then sends `question {text, source: "ptt", sttMs}` on the daemon ws. TTS: the desktop speaks each `fast_answer` sentence via the voice ws `speak` frame.
