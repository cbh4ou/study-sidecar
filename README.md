# Study Sidecar

Study Sidecar is a standalone coding companion for local agent sessions.

Install [Bun](https://bun.sh) and run `bun install`. The voice worker also uses
[uv](https://docs.astral.sh/uv/).

```sh
bun run sidecar up --with-voice --with-desktop
```

`up` starts the daemon on port `4321` with `--harness auto`. Use `--harness omp|pi|claude|codex|hermes|auto` to choose the session source and `--port <port>` to change the daemon port. Hermes reads the latest session from `$HERMES_HOME/state.db` (or `~/.hermes/state.db`) through a read-only SQLite connection. `--with-voice` starts the local worker and publishes `.run/voice.json` after `ws://127.0.0.1:8879` is reachable. `--with-desktop` starts the desktop dev server; if its dependencies are unavailable, the supervisor opens the daemon URL with `xdg-open` instead. `bun run sidecar status` reports child state, restart counts, and a redacted daemon-token marker; `bun run sidecar down` stops the recorded process tree.

The daemon port is configurable via `--port`.

## Security

The daemon binds loopback only (`127.0.0.1`) and requires a daemon token on every route, including the `/ws` and `/voice-ws` handshakes: send `Authorization: Bearer <token>` or `?token=<token>`. `up` generates an independent daemon token and voice-worker token per launch (or reuses `SIDECAR_TOKEN` / `--token <token>` and `SIDECAR_VOICE_TOKEN` / `--voice-token <token>`). It stores only the daemon token in `.run/token` with mode `0600`, passes both tokens to the daemon, passes only `SIDECAR_VOICE_TOKEN` to the worker, and passes only `SIDECAR_TOKEN` to desktop. The voice token is environment-only and never reaches the desktop; the daemon bearer never reaches port `8879`. Running the daemon standalone without a token makes it generate one and print `sidecar token: <token>` once. `sidecar status` never prints token values.

Host headers must name `127.0.0.1` or `localhost` (any port). Browser origins are allowlisted for loopback dev servers (`http(s)://127.0.0.1|localhost[:port]`) and the Tauri shell (`tauri://localhost`, `http://tauri.localhost`); allowlisted origins get echoed `Access-Control-Allow-Origin` plus `Authorization`/`Content-Type` headers on `GET, POST, OPTIONS`, everyone else gets no CORS headers and is blocked by the browser.

`POST /okf/save` (auth'd) persists a concept card through the OKF store: body `{ "title", "body", "topics?" }` with title ≤ 200 characters, body ≤ 20 000 characters, and at most 12 topics; it responds `{ "path" }`.

## Desktop authentication

Every daemon HTTP and WebSocket request requires the shared token. The supervisor exports `SIDECAR_TOKEN` to the desktop child; rsbuild injects it into the bundle (`window.__SIDECAR_TOKEN__`) and the Tauri `sidecar_token` command reads the environment as fallback. Running the desktop without the supervisor (plain `bun run dev`) leaves no token: the daemon still prints its token at startup, and desktop requests will answer 401 until the token is provided (start rsbuild with `SIDECAR_TOKEN` set).

## HUD behavior

The desktop contracts to a pill: the compact/ambient island is an undecorated ~420×72 window (the Tauri `set_hud_variant` command resizes on HUD state changes) and expands back to 420×700. Ambient, guardrail, and dead-air insights render as Spotter bubbles and are spoken through the active TTS path. Tutor answers may embed `mermaid` fenced diagrams, rendered with `obsidianmd/pele`; clicking a node scrolls to the matching trace entry. The Scratchpad tab renders the durable live canvas and research note. Socratic mode commits interactive questionnaire data, and steering prompts copy with `Alt+C`. Questions typed while disconnected queue and flush on reconnect; daemon errors appear in an aria-live list.

## Voice router

The daemon selects the authenticated local worker first; if it is unavailable and `OPENAI_API_KEY` is set, it selects OpenAI Realtime, otherwise voice is unavailable. Before advertising local voice, it opens `ws://127.0.0.1:8879?token=<voice-token>` and requires the worker's first message to be `ready`; this result is cached briefly. `GET /voice` reports `{ kind, ws_url }`, with `ws_url` set to the daemon's authenticated `/voice-ws` proxy for either available engine, never the worker URL.

OpenAI Realtime is routed by the daemon with server VAD and interruption enabled and reads `OPENAI_API_KEY` server-side; it never falls back to a browser-visible environment key. The desktop always connects to the daemon proxy with its daemon token, while the daemon alone sends the separate voice token to the local worker. Both routes stop active playback when speech begins.

The voice worker accepts one authenticated WebSocket client at `ws://127.0.0.1:8879` per connection. It requires `?token=<SIDECAR_VOICE_TOKEN>` or `Authorization: Bearer <SIDECAR_VOICE_TOKEN>` and rejects unauthorized clients with an error frame and policy-violation close. If no voice token is configured, it generates and prints an ephemeral token once. `up --with-voice` installs the declared voice extra through uv, including CUDA 12 libraries for faster-whisper. For offline TTS, download [Kokoro's official model and voices](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1) to `~/.study-sidecar/models/kokoro-v1.0.onnx` and `~/.study-sidecar/models/voices-v1.0.bin`; custom paths use `KOKORO_MODEL_PATH` and `KOKORO_VOICES_PATH`. Whisper downloads `distil-large-v3` on its first transcription, so run it once online before relying on offline use. On the target RTX 4060, Whisper uses CUDA `int8_float16` and Kokoro defaults to CPU so both models can coexist; setting `ONNX_PROVIDER=CUDAExecutionProvider` needs more free VRAM. Without the optional dependencies the worker remains protocol-compatible with energy VAD and unavailable STT/TTS notices.

| Direction | Messages |
| --- | --- |
| Client → daemon proxy → worker | `listen_start`, `listen_stop`, `audio` (`pcm_b16`: base64 s16le, 16 kHz mono), `speak` (`id`, `text`, optional `voice`), `interrupt` |
| Worker → daemon proxy → client | `ready` (`vad`, `tts`), `vad` (`speech`), final `transcript`, `tts_started`, streamed `tts_audio`, `tts_stopped`, `error` |

Speech starts and ends are reported as VAD events; 600 ms of silence finalizes a transcript. Send `interrupt` to stop active speech output immediately.

## Tutor harness

The tutor is a real agent, not a bare LLM call: `apps/daemon/src/tutor/harness.ts` opens its own isolated Pi Durable harness (`@earendil-works/pi-durable`) rooted in `~/.study-sidecar/` — `tutor.sqlite` for the durable transcript and `workspace/scratch/` for 0600 throwaway notes and Mermaid canvases. Tutor directories are 0700. It never opens a watched session in the Pi Durable harness; Pi, OMP, Claude, and Codex use read-only byte-offset JSONL tailers, Hermes uses a read-only SQLite connection, and optional Durable SSE is read-only. SQLite's WAL protocol can create or update shared-memory coordination files even for read-only clients, so Hermes cannot satisfy a literal zero-lock requirement. A separate tool may read at most 64 KiB from a real file contained by the attached repository.

The model comes from the Pi registry (`~/.pi/agent/models-store.json` + `auth.json`) through a custom pi-ai provider. Study exchanges use native durable compaction and six typed documents (`hud_state`, `scratchpad_diagram`, `socratic_quiz`, `steering_prompt`, `research_scratchpad`, `tutor_trace`) streamed to the HUD. The system prompt includes the active mode, redacted session context, OKF hints, and complete bundled and user `SKILL.md` instructions. Its six scoped tools are `read_watched_repo_file`, `search_okf_memory`, `save_okf_concept_card`, `write_study_scratchpad`, `update_mermaid_canvas`, and `emit_hud_artifacts`; `search_okf_memory` can also call an installed `notebooklm` CLI against tutor-owned configuration.

At first startup, Sidecar chooses one authenticated Pi model and saves it in
`~/.study-sidecar/model.json`. Change it from Desktop Settings; the choice is
used on the next launch too. `SIDECAR_MODEL` or daemon `--model` overrides the
saved choice for a launch.

Permanent concepts use OKF v0.2 Markdown under `~/.study-sidecar/.okf/concepts/`. `qmd` collection names include a hash of each bundle root, preventing cross-project collection reuse; the deterministic fallback remains available when `qmd` is absent.
`qmd`, `notebooklm`, model credentials, cloud voice credentials, and local GPU models remain user-installed integrations. Authenticate them manually; the Sidecar never logs in or copies credentials. Without `qmd`, OKF queries use the bounded keyword fallback. Without `notebooklm`, the optional NotebookLM branch returns an explicit tool error.

The desktop uses Rsbuild 2. The sub-15 ms memory benchmark covers the keyword fallback; `qmd` was unavailable in the development environment and its subprocess latency is not yet verified. The local voice route was exercised with CUDA Whisper loading and an interrupted Kokoro audio stream. The 40 ms first-audio and combined 55 MB RAM targets do not pass on this machine: a warm short sentence took 0.81 s with the default CPU Kokoro; after synthesis the daemon used about 82 MB RSS and the Python voice worker about 1.25 GB RSS. The Rsbuild development server separately used about 405 MB RSS.

## Development

The daemon WebSocket protocol lives canonically in `apps/daemon/src/protocol.ts`. `bun run gen-protocol` copies it (with a generated header) to `apps/desktop/src/lib/protocol.ts`; a drift test fails the build if the two ever diverge, so never hand-edit the desktop copy.

The desktop UI is Tailwind CSS v4 (PostCSS) plus upstream registry components — never hand-rolled look-alikes. `apps/desktop/src/components/ui/` and `apps/desktop/src/components/ai-elements/` are vendored verbatim from their registries (shadcn/ui base, Prompt-Kit `prompt-input`/`prompt-suggestion`/`steps`, Cult UI `dynamic-island`, Motion Primitives `transition-panel`/`morphing-dialog`, AI Elements `conversation`/`message`/`code-block`/`question`); Biome linting is disabled for those directories and updates go through the registry CLIs (`bunx shadcn@latest add <registry-url>`), not manual edits. `lucide-react` supplies icons and `motion` powers the animation primitives.

Performance assertions cover the deterministic paths: the Tier-0 sieve median (<5 ms) and the OKF keyword-fallback query over a 200-card corpus (median <15 ms), both with warmup plus median-of-20 to avoid flake. The `qmd`-backed lookup path is only measurable where `qmd` actually installs; CI covers the fallback path.

