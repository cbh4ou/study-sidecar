# Study Sidecar

Study Sidecar is a standalone coding companion for local agent sessions.

Install [Bun](https://bun.sh) and run `bun install`. The voice worker also uses
[uv](https://docs.astral.sh/uv/).

```sh
bun run sidecar up --with-voice --with-desktop
```

`up` starts the daemon on port `4321` with `--harness auto`. Use `--harness omp|pi|auto` to choose the session source and `--port <port>` to change the daemon port. `--with-voice` starts the local worker and publishes `.run/voice.json` after `ws://127.0.0.1:8879` is reachable. `--with-desktop` starts the native Tauri shell and its frontend dev server; if its dependencies are unavailable, the supervisor opens the daemon URL with `xdg-open` instead. `bun run sidecar status` reports child state, restart counts, and a redacted daemon-token marker; `bun run sidecar down` stops the recorded process tree.

The daemon port is configurable via `--port`.

## Security

The daemon binds loopback only (`127.0.0.1`) and requires a daemon token on every route, including the `/ws` and `/voice-ws` handshakes: send `Authorization: Bearer <token>` or `?token=<token>`. `up` generates an independent daemon token and voice-worker token per launch (or reuses `SIDECAR_TOKEN` / `--token <token>` and `SIDECAR_VOICE_TOKEN` / `--voice-token <token>`). It stores only the daemon token in `.run/token` with mode `0600`, passes both tokens to the daemon, passes only `SIDECAR_VOICE_TOKEN` to the worker, and passes only `SIDECAR_TOKEN` to desktop. The voice token is environment-only and never reaches the desktop; the daemon bearer never reaches port `8879`. Running the daemon standalone without a token makes it generate one and print `sidecar token: <token>` once. `sidecar status` never prints token values.

Host headers must name `127.0.0.1` or `localhost` (any port). Browser origins are allowlisted for loopback dev servers (`http(s)://127.0.0.1|localhost[:port]`) and the Tauri shell (`tauri://localhost`, `http://tauri.localhost`); allowlisted origins get echoed `Access-Control-Allow-Origin` plus `Authorization`/`Content-Type` headers on `GET, POST, OPTIONS`, everyone else gets no CORS headers and is blocked by the browser.

`POST /okf/save` (auth'd) persists a concept card through the OKF store: body `{ "title", "body", "topics?" }` with title ≤ 200 characters, body ≤ 20 000 characters, and at most 12 topics; it responds `{ "path" }`.

## Desktop authentication

Every daemon HTTP and WebSocket request requires the shared token. The supervisor exports `SIDECAR_TOKEN` to the desktop child; rsbuild injects it into the bundle (`window.__SIDECAR_TOKEN__`) and the Tauri `sidecar_token` command reads the environment as fallback. Running the desktop without the supervisor (plain `bun run dev`) leaves no token: the daemon still prints its token at startup, and desktop requests will answer 401 until the token is provided (start rsbuild with `SIDECAR_TOKEN` set).

## HUD behavior

The desktop contracts to a pill: the compact/ambient island is an undecorated ~420×72 window (the Tauri `set_hud_variant` command resizes on HUD state changes) and expands back to 420×700. Ambient, guardrail, and dead-air insights remain visual. Spoken replies come only from the short fast lane. Tutor answers may embed `mermaid` fenced diagrams, rendered with `obsidianmd/pele`; clicking a node scrolls to the matching trace entry. The Scratchpad tab renders the durable live canvas and research note. Socratic mode commits interactive questionnaire data, and steering prompts copy with `Alt+C`. Questions typed while disconnected queue and flush on reconnect; daemon errors appear in an aria-live list.

## Voice router

The daemon selects the authenticated local worker first; if it is unavailable, voice remains unavailable unless OpenAI Realtime was explicitly selected and `OPENAI_API_KEY` is set. Before advertising local voice, it opens `ws://127.0.0.1:8879?token=<voice-token>` and requires the worker's first message to be `ready`; this result is cached briefly. `GET /voice` reports `{ kind, ws_url }`, with `ws_url` set to the daemon's authenticated `/voice-ws` proxy for either available engine, never the worker URL.

OpenAI Realtime is routed by the daemon with server VAD and interruption enabled and reads `OPENAI_API_KEY` server-side; it never falls back to a browser-visible environment key. The desktop always connects to the daemon proxy with its daemon token, while the daemon alone sends the separate voice token to the local worker. Both routes stop active playback when speech begins.

The voice worker accepts one authenticated WebSocket client at `ws://127.0.0.1:8879` per connection. It requires `?token=<SIDECAR_VOICE_TOKEN>` or `Authorization: Bearer <SIDECAR_VOICE_TOKEN>` and rejects unauthorized clients with an error frame and policy-violation close. If no voice token is configured, it generates and prints an ephemeral token once. Install the optional local-model dependencies with `uv sync --extra voice` before using Silero, Whisper, or Kokoro; without them it remains protocol-compatible with energy VAD and unavailable STT/TTS notices.

| Direction | Messages |
| --- | --- |
| Client → daemon proxy → worker | `listen_start`, `listen_stop`, `audio` (`pcm_b16`: base64 s16le, 16 kHz mono), `speak` (`id`, `text`, optional `voice`), `interrupt` |
| Worker → daemon proxy → client | `ready` (`vad`, `tts`), `vad` (`speech`), final `transcript`, `tts_started`, streamed `tts_audio`, `tts_stopped`, `error` |

Speech starts and ends are reported as VAD events. Explicit `listen_stop` finalizes push-to-talk immediately; optional VAD listening finalizes after 600 ms of silence. Send `interrupt` to stop active speech output immediately.

## Tutor harness

The tutor is a real agent, not a bare LLM call: `apps/daemon/src/tutor/harness.ts` opens its own isolated Pi Durable harness (`@earendil-works/pi-durable`) rooted in `~/.study-sidecar/` — `tutor.sqlite` for the durable transcript and `workspace/scratch/` for 0600 throwaway notes and Mermaid canvases. Tutor directories are 0700. It never opens the watched sessions' storage; those remain read-only byte-offset JSONL tailers plus the optional read-only Durable SSE stream. A separate tool may read at most 64 KiB from a real file contained by the attached repository.

The model comes from the Pi registry (`~/.pi/agent/models-store.json` + `auth.json`) through a custom pi-ai provider. Study exchanges use native durable compaction and six typed documents (`hud_state`, `scratchpad_diagram`, `socratic_quiz`, `steering_prompt`, `research_scratchpad`, `tutor_trace`) streamed to the HUD. The system prompt includes the active mode, redacted session context, OKF hints, and complete bundled and user `SKILL.md` instructions. Its six scoped tools are `read_watched_repo_file`, `search_okf_memory`, `save_okf_concept_card`, `write_study_scratchpad`, `update_mermaid_canvas`, and `emit_hud_artifacts`; `search_okf_memory` can also call an installed `notebooklm` CLI against tutor-owned configuration.

At first startup, Sidecar chooses one authenticated Pi model and saves it in
`~/.study-sidecar/model.json`. Change it from Desktop Settings; the choice is
used on the next launch too. `SIDECAR_MODEL` or daemon `--model` overrides the
saved choice for a launch.

Permanent concepts use OKF v0.2 Markdown under `~/.study-sidecar/.okf/concepts/`. `qmd` collection names include a hash of each bundle root, preventing cross-project collection reuse; the deterministic fallback remains available when `qmd` is absent.
`qmd`, `notebooklm`, model credentials, cloud voice credentials, and local GPU models remain user-installed integrations. Authenticate them manually; the Sidecar never logs in or copies credentials. Without `qmd`, OKF queries use the bounded keyword fallback. Without `notebooklm`, the optional NotebookLM branch returns an explicit tool error.

## Development

The daemon WebSocket protocol lives canonically in `apps/daemon/src/protocol.ts`. `bun run gen-protocol` copies it (with a generated header) to `apps/desktop/src/lib/protocol.ts`; a drift test fails the build if the two ever diverge, so never hand-edit the desktop copy.

The desktop UI is Tailwind CSS v4 (PostCSS) plus upstream registry components — never hand-rolled look-alikes. `apps/desktop/src/components/ui/` and `apps/desktop/src/components/ai-elements/` are vendored verbatim from their registries (shadcn/ui base, Prompt-Kit `prompt-input`/`prompt-suggestion`/`steps`, Cult UI `dynamic-island`, Motion Primitives `transition-panel`/`morphing-dialog`, AI Elements `conversation`/`message`/`code-block`/`question`); Biome linting is disabled for those directories and updates go through the registry CLIs (`bunx shadcn@latest add <registry-url>`), not manual edits. `lucide-react` supplies icons and `motion` powers the animation primitives.

Performance assertions cover the deterministic paths: the Tier-0 sieve median (<5 ms) and the OKF keyword-fallback query over a 200-card corpus (median <15 ms), both with warmup plus median-of-20 to avoid flake. The `qmd`-backed lookup path is only measurable where `qmd` actually installs; CI covers the fallback path.


### MVP v4.3 workspace

MVP v4.3 lives on `feat/mvp-v4.3`. Start the offline demonstration with:

```sh
bun install --frozen-lockfile
bun run sidecar up --fake --with-desktop
```

Fake mode uses an isolated sidecar home, scripted model/decision/search/voice
adapters and a read-only session replay. It needs no model credentials, GPU or
microphone. For browser development, run `SIDECAR_TOKEN=<daemon-token> SIDECAR_PORT=4321 bun run
--cwd apps/desktop dev`; the token is injected at build time.

The pill stays beside the coding session. Open the main app with Alt+O for the
knowledge graph, Classroom, Sessions, Review and Settings. Hold Alt+Space to
dictate and release to send. Esc interrupts; Alt+S expands the pill; Alt+C copies
the steering prompt; Alt+P suggests an anchor for confirmation; Alt+D hides the
pill during calls or screen sharing. Shortcuts are configurable in Settings.
Screen-share privacy uses the manual DND fallback on platforms without capture
detection. The main window starts hidden and opens maximized.

A new lesson starts by measuring prerequisites, records a prerequisite plan,
then teaches with recall and explain-back checks. Graph propositions and chains
remain separate from learner review state. Review schedules are derived from
append-only FSRS logs. Session source settings independently control local-only
privacy and graph indexing. Local-only sources never reach cloud models,
classification or web research; select local lane models to study them.

Real speech uses the local Python worker. Cloud Realtime speech requires an
explicit selection. PDF research requires the `pdftotext` executable (Debian/
Ubuntu: `sudo apt install poppler-utils`). PDF and run-log tools read their
sources without modifying them. Web search supports Brave or Tavily with a
write-only key in Settings. Background research acknowledges immediately and
publishes cited results in the lesson and Activity dock; jobs can be aborted.

Register the asynchronous tutor MCP tools with Claude Code:

```sh
claude mcp add study-sidecar -- bun run sidecar mcp
```

Run registration from this repository, or use an absolute path to
`bin/sidecar.ts`. The server reads the daemon token from `.run/token` (or
`SIDECAR_TOKEN`) and exposes `tutor_ask`, `tutor_note` and the `tutor` prompt.
`tutor_ask` returns only `{ status: "sent", ticket }`; answers appear in the
learner's pill and panel. Notes are queued for session recap/card candidates.

Validation:

```sh
bun run check
bun run test
bun run typecheck
bun run --cwd apps/desktop build
bunx playwright install chromium
bun run test:browser
```

The browser check starts a temporary fake daemon and web server. Ports 4321 and
3137 must be free. It checks real rendered lesson/review/graph/session/pill
flows and saves screenshots under `.run/mvp-browser/`. Native compilation can
be checked with `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`.
Worker tests run with `uv run --project workers/voice-local --group test pytest
workers/voice-local/tests -q`.
