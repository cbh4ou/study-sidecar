# Study Sidecar: MVP Delta Spec v4.3

> **For the implementing agent.** This is a *delta* spec against `cbh4ou/study-sidecar@ad817bd`. Everything listed under "Baseline" already exists and works: extend it, do not rebuild it. Build phases in order (Section 14). Every phase must leave `bun run check`, `bun run test`, and `bun run typecheck` green. No item in this spec is optional unless it is in Section 3.2 (Deferred).

---

## 0. Ground Rules

1. **Do not edit vendored UI.** `apps/desktop/src/components/ui/` and `apps/desktop/src/components/ai-elements/` change only through registry CLIs (`bunx shadcn@latest add <url>`). New components go in `apps/desktop/src/components/` (outside those two dirs).
2. **Protocol is canonical in the daemon.** Edit `apps/daemon/src/protocol.ts` only, then run `bun run gen-protocol`. The drift test must pass.
3. **Every external effect sits behind a port with a fake.** LLM lanes, Decide (Jev), web search, STT/TTS, clock. `SIDECAR_FAKE=1` wires every fake (Section 12).
4. **One writer per store.** Each file under `~/.study-sidecar/` has exactly one owning module (Section 9).
5. **Append-only evidence, derived state.** Graph ledgers and review logs are JSONL append-only. Statuses, due dates, and graph views are recomputed on read.
6. **Read-only taps stay read-only.** Nothing writes inside watched session dirs or the attached repo.
7. **Local by default.** STT and TTS stay on the local worker. Any cloud call (LLM, Jev, web) receives only `redact()`ed text, and never for a source marked `local_only`.
8. **Telemetry, not gates.** Latency is logged and shown in the Activity dock. No test asserts model or voice latency.
9. No em-dashes in user-facing copy.

---

## 1. Product Summary

A local, voice-first study partner that runs beside any coding CLI. The user keeps working in Claude Code (or Pi, omp, Codex) and **talks to the tutor without switching windows**. Quick spoken answers arrive in about a second; detail lands in a panel they can glance at. When they want to go deep, they open the full app: a LearnHarness-style classroom with a plan, questions, visuals, and a knowledge graph that grows across sessions. The tutor teaches any subject, not only code.

**Two surfaces, one daemon:**

| Surface | When | What it does |
|---|---|---|
| **Pill** (default) | While working in a session | Push-to-talk, short spoken answers, one-line cards, refresher badge, steering prompt copy |
| **Main app** | When the user wants depth or setup | Graph home, Classroom, Sessions, Review, Settings |

---

## 2. Baseline (Already Built, Keep)

| Area | Existing module | Notes |
|---|---|---|
| Supervisor CLI | `bin/sidecar.ts` (`up`, `status`, `down`) | Keep. Add `--fake` flag (Section 12) |
| Auth + loopback | `apps/daemon/src/auth.ts` | Keep. New routes reuse it |
| Session ingest | `ingest/manager.ts`, `pi-jsonl.ts`, `pi-durable.ts`, `harness.ts` | Harness enum already has `pi \| omp \| codex \| claude \| auto` |
| Tier-0 sieve | `sieve/tier0.ts`, `sieve/dead-air.ts` | Keep. Feeds the Context Packet |
| Delta classifier | `tutor/engine.ts` `classifyDelta()` | Becomes the **rule fallback** for `DecidePort` |
| Tutor harness | `tutor/harness.ts` (pi-durable, `tutor.sqlite`, 6 docs, 6 tools) | Becomes the **deep lane** |
| Redaction | `tutor/redact.ts` | Run before every cloud call |
| Memory | `memory/okf-store.ts`, `memory/qmd-client.ts` (OKF v0.2 + qmd) | Keep as the concept-card/fuzzy recall store. Exabase is **not** used |
| Modes | `modes/*.md`, `modes/modes.ts` | Keep. Socratic is the default |
| Voice | `voice/router.ts`, `workers/voice-local/server.py` | Local worker first. Add push-to-talk (Section 7) |
| Desktop | Tauri v2, `MentorHud.tsx`, DynamicIsland pill, `Alt+S`, `Alt+C` | Split into two windows (Section 4) |
| Diagrams | `pele` via `mermaid-view.tsx` | Keep |

---

## 3. Scope

### 3.1 MVP (build all)

| ID | Feature |
|---|---|
| F1 | Two-window shell: Pill window + Main window |
| F2 | Push-to-talk dictation (global hotkey) + interrupt |
| F3 | Two-lane answering: fast spoken lane + deep panel lane |
| F4 | Context Packet builder with hard token cap |
| F5 | `DecidePort` (Jev adapter, LLM-structured adapter, rule adapter, fake) |
| F6 | Knowledge graph: propositions + reasoning chains, extraction pipeline (single writer) |
| F7 | Graph home view + chain table |
| F8 | Classroom: Measure, Plan, Teach loop with question dock and plan panel |
| F9 | Review queue: FSRS cards with 1-tap or voice grading |
| F10 | Explain-back check |
| F11 | MCP server: `tutor_ask`, `tutor_note` |
| F12 | Web research tool (async, cited) |
| F13 | Pinned anchor with confirm |
| F14 | Session-end recap |
| F15 | `local_only` sources + DND / screen-share hide |
| F16 | Fake mode |
| F17 | Activity dock with telemetry |

### 3.2 Deferred (do not build)

Always-on VAD listening as default (keep existing toggle as a Settings option), OpenAI Realtime as a primary path, spoken proactive nudges, extra personas beyond existing modes, multi-device sync, practice problem-set generator (LearnHarness-style ladder), graph clustering beyond birth-session grouping.

### 3.3 Cut

Exabase, graphology DAG, the 55 MB RAM claim, sub-5 ms latency as acceptance gates, shell-hook interception of `/tutor`.

---

## 4. UX Specification

### 4.1 Windows (Tauri)

| Window | Label | Size | Flags |
|---|---|---|---|
| Pill | `pill` | 420x72 compact, 420x220 card, 420x700 expanded | undecorated, always-on-top, skip taskbar, transparent |
| Main | `main` | opens **maximized / full screen**, resizable, min 900x600 | normal decorated window, hidden at launch; web build (`rsbuild dev` in a browser) fills the viewport too |

- Both windows share one daemon WebSocket per window (existing `ws.tsx`).
- `Alt+S` toggles the pill expanded state (existing). **`Alt+O`** opens or focuses Main on the current context.
- Pill gets a "Open in app" button that opens Main at `/classroom/:lessonId` for the current thread.
- Pill hides automatically while screen share or a call is detected (best effort: OS screen-capture APIs where available, else a manual DND toggle). DND toggle: **`Alt+D`**.

### 4.2 Pill states

| State | Size | Content |
|---|---|---|
| `idle` | compact | Session name, mic icon, due-cards badge (`3 due`) |
| `listening` | compact | Live level meter + partial transcript (one line) |
| `thinking` | compact | Shimmer + "Thinking" |
| `speaking` | card | Spoken answer text (1 to 2 sentences) + "More" link when deep lane has content |
| `card` | card | Explain-back or review card with grade buttons |
| `expanded` | expanded | Existing MentorHud tabs: Mentor, Scratchpad |

The pill is **bound to one session** at a time. Two binding modes: **Follow active** (default: rebinds to whichever watched session wrote most recently, debounced 10 s) and **Pinned** (stays on the chosen session). A session chip in the pill opens a picker (harness, project, live/idle, pending `tutor_note` count, `local_only` lock). Binding only sets the default Context Packet; the tutor can always call `search_across_sessions`, and the `intent` decision `question_all_sessions` ("across all sessions") widens one turn to every non-`local_only` session.

### 4.3 Main app routes (TanStack Router)

| Route | Name | Content |
|---|---|---|
| `/` | **Graph home** | Canvas graph of propositions (nodes) and chains (implication diamonds); search; "Chains" button opens the chain table overlay |
| `/classroom` | Lesson list | Past and active lessons, "New lesson" (topic text or "from pinned anchor") |
| `/classroom/:lessonId` | **Classroom** | Header: phase breadcrumb + Measure results (per-prerequisite `solid \| shaky \| new`). Left rail: **Sources** (code anchors, run logs, papers/PDFs, URLs, running research jobs; "Add PDF or URL"). Center: conversation with math (KaTeX via existing `@streamdown/math`), code, inline charts. Bottom: **Question dock** (quiz/ask/explain-back) + dictation. Right rail: **Plan panel** (DAG, statuses derived, queued prerequisite gaps, graph contribution count) |
| `/sessions` | Sessions | Session list (harness, project, live/idle, concepts touched) + detail (recent Tier-0 receipts, agent `tutor_note`s, concepts touched, pinned anchors, Bind pill, Start lesson from session, `local_only` and Index-into-graph toggles) + an **Across sessions** strip listing propositions sourced from 2+ sessions |
| `/review` | Review | Due cards queue, grade buttons (Again/Hard/Good/Easy), streak-free (no gamification) |
| `/settings` | Settings | Existing (mode, model, voice) + lanes (fast/deep model), Decide adapter + threshold, web search provider key, PTT hotkey, VAD toggle, privacy defaults |

Global chrome: left sidebar (routes), top bar, bottom-right **Activity dock** (background jobs, abort buttons, last-turn telemetry: `stt_ms`, `ttft_ms`, `tts_first_audio_ms`, `packet_tokens`).

### 4.4 Keyboard map

| Key | Action |
|---|---|
| `Alt+Space` (hold) | Push-to-talk. Release sends. Pressing while TTS plays interrupts it first |
| `Esc` (pill focused) | Interrupt TTS, cancel current turn |
| `Alt+S` | Expand / collapse pill (existing) |
| `Alt+O` | Open / focus Main window |
| `Alt+C` | Copy steering prompt (existing) |
| `Alt+D` | Do Not Disturb toggle |
| `Alt+P` | Pin anchor (shows confirm card in pill) |

All hotkeys configurable in Settings; register through `tauri_plugin_global_shortcut` in `src-tauri/src/lib.rs`.

---

## 5. Architecture Delta (new and changed files)

```
apps/daemon/src/
├── protocol.ts                 # CHANGED: new message variants (Section 6.3)
├── index.ts                    # CHANGED: wire new routes + MCP + lanes
├── ports/
│   ├── llm.ts                  # NEW: LlmPort { stream(lane, packet|messages) }
│   ├── decide.ts               # NEW: DecidePort + Decision types
│   ├── web.ts                  # NEW: WebSearchPort { search, fetch }
│   └── clock.ts                # NEW: Clock (now, setTimeout) for tests
├── adapters/
│   ├── llm-pi.ts               # NEW: pi-ai via Pi registry (reuses tutor/provider.ts)
│   ├── llm-fake.ts             # NEW: scripted responses (pi-ai faux provider)
│   ├── decide-jev.ts           # NEW: Jev HTTP adapter (cloud, redacted input)
│   ├── decide-llm.ts           # NEW: structured-output LLM classifier
│   ├── decide-rules.ts         # NEW: wraps classifyDelta + keyword rules
│   ├── decide-fake.ts          # NEW: deterministic table
│   ├── web-provider.ts         # NEW: one provider (Brave or Tavily, key in settings)
│   └── web-fake.ts             # NEW: canned results
├── lanes/
│   ├── packet.ts               # NEW: ContextPacket builder + token cap
│   ├── fast.ts                 # NEW: fast lane (no tools, spoken output rules)
│   ├── deep.ts                 # NEW: deep lane (delegates to tutor/harness.ts)
│   └── router.ts               # NEW: intent + lane routing via DecidePort
├── graph/
│   ├── contracts.ts            # NEW: Proposition, Chain, SourceRef
│   ├── store.ts                # NEW: JSONL ledgers (sole writer = extraction)
│   ├── extraction.ts           # NEW: extractor -> auditor -> merger
│   ├── derive.ts               # NEW: snapshot, implication nodes, birth-session groups
│   └── simplify.ts             # NEW: redundant-chain removal at merge
├── learn/
│   ├── lessons.ts              # NEW: lesson records (Measure/Plan/Teach phases)
│   ├── plan.ts                 # NEW: plan_init DAG parse + derived statuses
│   ├── questions.ts            # NEW: quiz/ask/explain-back contracts + grading
│   ├── cards.ts                # NEW: FSRS cards (ts-fsrs), review log
│   └── recap.ts                # NEW: session-end recap
├── mcp/
│   └── server.ts               # NEW: MCP stdio server (tutor_ask, tutor_note)
├── privacy/
│   └── sources.ts              # NEW: local_only registry, cloud gate
├── telemetry.ts                # NEW: per-turn timings ring buffer
└── (existing dirs unchanged unless noted)

apps/desktop/src/
├── windows/
│   ├── PillApp.tsx             # NEW: pill root (wraps existing MentorHud)
│   └── MainApp.tsx             # NEW: main window root + sidebar + routes
├── pages/
│   ├── GraphHome.tsx           # NEW
│   ├── ChainTable.tsx          # NEW
│   ├── ClassroomList.tsx       # NEW
│   ├── Classroom.tsx           # NEW
│   ├── Sessions.tsx            # NEW
│   ├── Review.tsx              # NEW
│   └── Settings.tsx            # MOVED from routes.tsx + extended
├── components/
│   ├── PlanPanel.tsx           # NEW
│   ├── QuestionDock.tsx        # NEW (uses ai-elements/question)
│   ├── DictationBar.tsx        # NEW
│   ├── ActivityDock.tsx        # NEW
│   ├── GraphCanvas.tsx         # NEW (Canvas 2D + d3-force)
│   └── PillStates.tsx          # NEW (idle/listening/thinking/speaking/card)
├── voice/
│   └── PushToTalk.ts           # NEW: hotkey-driven listen_start/stop
└── routes.tsx                  # CHANGED: split per window

apps/desktop/src-tauri/src/lib.rs   # CHANGED: second window, new shortcuts, DND
workers/voice-local/server.py       # CHANGED: honor explicit listen_stop as finalize (PTT)
```

New dependencies: `ts-fsrs`, `d3-force`, `d3-zoom`, `@modelcontextprotocol/sdk`, `zod`.

---

## 6. Contracts

All types live in the files named. Use `zod` schemas for every boundary (HTTP bodies, MCP tool inputs, LLM structured outputs, JSONL lines). JSONL readers drop invalid lines, never guess.

### 6.1 Graph (`graph/contracts.ts`)

```ts
export type SourceRef =
  | { kind: "session"; harness: Harness; sessionId: string; turnId?: string; file?: string; lines?: [number, number] }
  | { kind: "file"; path: string; lines?: [number, number] }
  | { kind: "web"; url: string; quote?: string }   // quote <= 200 chars
  | { kind: "pdf"; path: string; page: number; quote?: string }
  | { kind: "lesson"; lessonId: string; messageId: string }
  | { kind: "run"; path: string; metric?: string; step?: number };   // training/eval logs (jsonl/csv), read-only

export type Proposition = {
  id: string;            // "n_" + ulid
  name: string;          // <= 80 chars
  statement: string;     // one objective, world-facing claim
  aliases?: string[];
  sources: SourceRef[];
  createdAt: string;     // ISO
  birthSource: string;   // lessonId or sessionId that first minted it
};

export type Chain = {
  id: string;            // "arg_" + hash(sorted premises + conclusion)
  premises: string[];    // proposition ids, minItems 1
  conclusion: string;    // proposition id
  createdAt: string;
  sources: SourceRef[];
};
```

Rules: no self-reference; every id resolves; two independent arguments for one conclusion are two chains. Propositions never carry learner state.

### 6.2 Learning (`learn/*.ts`)

```ts
export type LessonPhase = "measure" | "plan" | "teach";
export type Lesson = {
  id: string; title: string; goal: string;
  anchors: SourceRef[];         // pinned anchors: code, runs, papers, URLs (0..8)
  measure?: Record<string, "solid" | "shaky" | "new">; // prerequisite -> level, from Measure phase
  phase: LessonPhase;           // derived from transcript, stored for list view only
  planMermaid?: string;         // author-once via plan_init
  createdAt: string; updatedAt: string;
};

export type Question =
  | { kind: "quiz"; id: string; prompt: string; options: { id: string; label: string }[]; correctId: string; planNode?: string }
  | { kind: "ask"; id: string; prompt: string }
  | { kind: "explain_back"; id: string; prompt: string; expectedPropositions: string[] };

export type ExplainBackVerdict = "correct" | "partial" | "misconception" | "off_topic";

export type Card = {
  id: string;
  propositionId: string;
  question: string;         // recall prompt, never names the answer
  example?: string;         // learner's own code or context
  source: SourceRef;
  createdAt: string;
};
export type ReviewLogLine = {
  cardId: string; at: string;
  rating: "again" | "hard" | "good" | "easy";
  by: "button" | "voice" | "explain_back";
  answerText?: string;
};
```

FSRS state is **derived** by replaying `reviews.jsonl` through `ts-fsrs` on read. Cards never write to the graph.

### 6.3 Protocol additions (`protocol.ts`)

```ts
// DaemonMessage additions
| { type: "turn_started"; turnId: string; source: "ptt" | "typed" | "mcp" }
| { type: "transcript"; turnId: string; text: string; final: boolean }
| { type: "fast_answer"; turnId: string; text: string }          // spoken
| { type: "deep_update"; turnId: string; documents: Partial<TutorDocuments> }
| { type: "turn_settled"; turnId: string; telemetry: TurnTelemetry }
| { type: "question"; lessonId?: string; question: Question }
| { type: "cards_due"; count: number }
| { type: "card_prompt"; card: Card }
| { type: "anchor_suggest"; anchor: SourceRef; preview: string }
| { type: "graph_changed" }                                       // notify, then fetch
| { type: "lessons_changed" }
| { type: "activity"; jobs: ActivityJob[] }

// ClientMessage additions
| { type: "ptt_start" } | { type: "ptt_stop" } | { type: "interrupt" }
| { type: "answer"; questionId: string; value: string }           // option id or free text
| { type: "grade"; cardId: string; rating: ReviewLogLine["rating"] }
| { type: "anchor_confirm"; accept: boolean }
| { type: "bind_session"; sessionPath: string }
| { type: "dnd"; on: boolean }
| { type: "abort_job"; jobId: string }

export type TurnTelemetry = {
  stt_ms?: number; decide_ms?: number; packet_tokens: number;
  fast_ttft_ms?: number; tts_first_audio_ms?: number; deep_total_ms?: number;
};
export type ActivityJob = { id: string; kind: "deep" | "research" | "extraction" | "recap"; label: string; status: "queued" | "running" | "done" | "error" };
```

Events notify; clients fetch durable data over HTTP (`GET /api/graph`, `/api/lessons`, `/api/cards/due`).

### 6.4 HTTP additions (all authed, loopback)

| Route | Method | Body / Response |
|---|---|---|
| `/api/graph` | GET | `{ nodes, chains, implications, groups }` (derived) |
| `/api/graph/nodes/:id` | DELETE | cascade-deletes chains referencing it |
| `/api/lessons` | GET, POST | list; create `{ title?, goal, anchor? }` |
| `/api/lessons/:id` | GET | lesson + transcript |
| `/api/cards/due` | GET | `{ cards: Card[] }` |
| `/api/sources` | GET, POST | list watched sources; set `{ path, local_only }` |
| `/api/telemetry` | GET | last 50 `TurnTelemetry` |

---

## 7. Voice Turn (Push-to-Talk)

```
Alt+Space down ─► desktop sends ptt_start ─► daemon: interrupt TTS, listen_start to worker
                                         └─► lanes/packet.ts warms packet (speculative)
(speech)       ─► worker streams vad + partial transcripts (if engine supports partials)
Alt+Space up   ─► ptt_stop ─► worker finalizes transcript immediately (no 600 ms wait)
transcript     ─► DecidePort.intent(text) ─► question | think_aloud | command | cancel | bridge_back
question       ─► DecidePort.lane(text)   ─► fast_only | fast_and_deep | needs_web
fast lane      ─► stream text ─► sentence-chunk ─► worker `speak` per sentence (TTS starts on 1st)
deep lane      ─► tutor harness turn ─► deep_update docs to panel (Mermaid, code, sources, cards)
```

- **Worker change:** on `listen_stop`, finalize the current utterance immediately. VAD auto-finalize (600 ms silence) stays for the optional always-listening mode.
- **STT/TTS engines:** keep whatever the worker supports; the engine choice is a Settings dropdown populated from the worker's `ready` frame. Add `engines: { stt: string[]; tts: string[] }` to `ready`.
- `think_aloud` intent: store text on the current lesson as learner reasoning (no answer spoken; pill shows "Noted").
- `bridge_back`: emit `steering_prompt` and copy it (existing Alt+C path).

### 7.1 Fast lane rules (`lanes/fast.ts`)

- Model: Settings `lanes.fast` (a small, fast model from the Pi registry). Default: the cheapest authenticated model.
- **No tool calls.** Input is the Context Packet only.
- Output: at most 2 sentences, no code, no markdown, no lists. If the answer needs code or a diagram, say so in one sentence ("I put the diagram in the panel").
- System prompt prefix must be byte-stable across turns (prompt caching).

### 7.2 Deep lane rules (`lanes/deep.ts`)

- Delegates to the existing `tutor/harness.ts` with its 6 tools plus new tools: `web_search`, `web_fetch`, `plan_init`, `ask_question`, `create_card`, `list_propositions`.
- Runs in parallel with the fast lane. Results stream as `deep_update`.
- Research runs as an Activity job (ack-and-continue): the tool returns an ack immediately; results arrive as a follow-up `deep_update`.

---

## 8. Context Packet (`lanes/packet.ts`)

Hard cap: **4,000 tokens** (count with a fixed chars/4 estimator; test enforces cap).

| Order | Section | Budget | Source |
|---|---|---|---|
| 1 | Tutor rules (active mode + `TUTOR.md`) | 700 | `modes/*.md` (cached prefix) |
| 2 | Learner snapshot | 300 | top recent propositions by recency + due cards' propositions |
| 3 | Pinned anchor skeleton | 900 | symbols and signatures only, never full bodies |
| 4 | Recent session receipts | 600 | last N Tier-0 receipts from the bound session |
| 5 | Recalled memory | 400 | OKF/qmd hits (3 to 5) |
| 6 | Lesson state | 300 | current plan node + last question |
| 7 | Question | rest | transcript |

Overflow trims from section 4, then 5, then 3. Every section is redacted. Packet is rebuilt on session events (debounced 250 ms) so it is warm before PTT.

---

## 9. Storage (`~/.study-sidecar/`)

| Path | Owner (sole writer) | Format |
|---|---|---|
| `tutor.sqlite` | `tutor/harness.ts` | existing |
| `workspace/scratch/` | `tutor/harness.ts` | existing |
| `.okf/concepts/` | `memory/okf-store.ts` | existing |
| `model.json` | `tutor/model-selection.ts` | existing |
| `graph/nodes.jsonl` | `graph/extraction.ts` | append-only `Proposition` lines |
| `graph/chains.jsonl` | `graph/extraction.ts` | append-only `Chain` lines |
| `graph/tombstones.jsonl` | `graph/store.ts` delete path | `{ id, at }` |
| `graph/coverage.jsonl` | `graph/extraction.ts` | `{ sourceId, messageHash }` |
| `lessons/*.json` | `learn/lessons.ts` | one file per lesson |
| `cards/cards.jsonl` | `learn/cards.ts` | append-only `Card` |
| `cards/reviews.jsonl` | `learn/cards.ts` | append-only `ReviewLogLine` |
| `sources.json` | `privacy/sources.ts` | `{ [path]: { local_only: boolean } }` |
| `settings.json` | settings module | lanes, decide, web, hotkeys, privacy |

All dirs 0700, files 0600 (match existing harness behavior).

---

## 10. DecidePort (Jev and fallbacks)

```ts
export type Decision<T extends string> = {
  choice: T; probs: Record<T, number>; confidence: number; adapter: "jev" | "llm" | "rules" | "fake";
};
export interface DecidePort {
  decide<T extends string>(task: DecideTask, input: string, options: readonly T[]): Promise<Decision<T>>;
}
export type DecideTask =
  | "delta_class" | "turn_relevance" | "concept_route" | "intent" | "lane"
  | "nudge_gate" | "explain_back" | "fsrs_rating" | "anchor_pick";
```

| Task | Options | Fallback |
|---|---|---|
| `delta_class` | `SILENT \| AMBIENT_PILL \| PROACTIVE_COACH` | existing `classifyDelta()` |
| `turn_relevance` | `include \| receipt_only \| drop` | rules on `event_type` + `tool_name` |
| `concept_route` | top-k proposition ids from FTS + `new_concept` | `new_concept` |
| `intent` | `question \| question_all_sessions \| think_aloud \| command \| cancel \| bridge_back` | keyword rules ("stop", "never mind", "send it back", "across all sessions") |
| `lane` | `fast_only \| fast_and_deep \| needs_web` | `fast_and_deep` |
| `nudge_gate` | `nudge \| hold` | `hold` |
| `explain_back` | `correct \| partial \| misconception \| off_topic` | LLM adapter |
| `fsrs_rating` | `again \| hard \| good \| easy` | map from `explain_back` verdict |
| `anchor_pick` | candidate hunk ids | most recent hunk |

**Composition:** `JevDecide` (if key set and source not `local_only`) -> if `confidence < settings.decide.threshold` (default 0.7) escalate to `LlmDecide` -> on any error use `RulesDecide`. Record `decide_ms` and `adapter` in telemetry. The Jev adapter receives redacted input only. **Never** use Decide for parsing JSONL structure (deterministic) or for generating text.

Jev HTTP shape is isolated in `adapters/decide-jev.ts`; if the real API differs, only that file changes.

---

## 11. Knowledge Graph Pipeline (`graph/*`)

Modeled on LearnHarness's extractor -> auditor -> merger. **Borrow the design only; LearnHarness is AGPL-3.0, copy no code.**

1. **Trigger:** when uncovered tutor-prose tokens in a lesson (or deep-lane answers in a session) reach 4,000, or at session-end recap. Single-flight per source; sources run serially, cross-source in parallel (max 2).
2. **Extractor (deep model):** sees only tutor prose for the batch, plus "graph so far" for this source. Submits `{ propositions[], chains[] }` via a schema-validated tool. Invalid submit returns an error string; model retries (max 3 turns).
3. **Auditor (deep model):** sees the new propositions only, plus read-only tools `find(text)` and `list_propositions(sourceId)`. Returns `{ links: { newId: existingId }[] }` (identity only, equivalence-biased).
4. **Merger (deterministic):** resolves links, dedupes chains by `(sorted premises, conclusion)`, runs `simplify.ts` (drop chains whose premise set is a strict superset of another chain's for the same conclusion, or fully covered by ancestry), appends lines, writes coverage, emits `graph_changed`.
5. **Failure at any stage checkpoints nothing.**

`derive.ts` builds the view on read: one implication node per chain, arrows premise -> implication -> conclusion, groups by `birthSource`.

---

## 12. Fake Mode (`SIDECAR_FAKE=1` or `sidecar up --fake`)

| Port | Fake behavior |
|---|---|
| LLM fast | Returns `"Fake answer to: <question>."` after 200 ms |
| LLM deep | Emits a fixed Mermaid diagram, a quiz `Question`, and one `create_card` |
| Decide | Table-driven from `fixtures/decide.json` |
| Web | Returns 3 canned results with URLs |
| Voice | Fake worker: `ptt_stop` returns transcript `"what is a channel ack"`; `speak` emits `tts_started` / 3 silent chunks / `tts_stopped` |
| Ingest | Replays `fixtures/session.jsonl` at 1 event/sec |

Fake mode must exercise every UI state in Section 13.2 without network or GPU.

---

## 13. Acceptance

### 13.1 Tests (bun test, deterministic, no network)

| ID | Test |
|---|---|
| T1 | Packet builder never exceeds 4,000 tokens across 50 randomized inputs; trims in the specified order |
| T2 | Redaction runs on every cloud-bound string (spy on adapters) |
| T3 | `local_only` source: Jev and web adapters are never called; LLM adapter receives no text from that source if its lane provider is cloud |
| T4 | Decide composition: low-confidence Jev escalates to LLM; adapter error falls to rules |
| T5 | Extraction: invalid submit triggers retry; failure writes nothing; merger dedupes and simplifies (fixture graph) |
| T6 | Deleting a proposition cascades to every chain referencing it |
| T7 | FSRS: replaying a review log yields deterministic due dates (fixed clock) |
| T8 | Explain-back verdict maps to rating: correct->good, partial->hard, misconception/off_topic->again |
| T9 | Intent routing: "stop" -> cancel; "send that back to Claude" -> bridge_back (fake + rules) |
| T10 | MCP `tutor_ask` returns `{ status: "sent", ticket }` and the answer never appears in the tool result |
| T11 | Protocol drift test still passes after additions |
| T12 | No writes occur outside `~/.study-sidecar/` (fs spy over a full fake session) |
| T13 | PTT: `ptt_stop` finalizes transcript without waiting for silence (worker unit test, pytest) |
| T14 | Plan statuses derive from tagged quiz answers; `plan_init` rejects cycles with a line-numbered error |

### 13.2 UI states (verify in fake mode)

Pill: idle with badge, listening with partial transcript, thinking, speaking with "More", card with grade buttons, anchor confirm, DND hidden. Main: empty graph, populated graph, chain table with search, classroom in each phase, question dock (quiz, ask, explain-back), plan panel with current/visited/upcoming, review queue empty and populated, sessions with `local_only` toggle, activity dock with running and errored jobs.

---

## 14. Build Phases

| Phase | Deliverables | Done when |
|---|---|---|
| P1 | Ports + fakes (Section 12), `--fake` flag, telemetry ring | `sidecar up --fake` runs end to end |
| P2 | Two-window shell, Main routes skeleton, sidebar, Activity dock | All routes render in fake mode |
| P3 | PTT (desktop + worker change), fast lane, packet builder, sentence-chunked TTS | Hold Alt+Space in fake mode -> spoken fake answer |
| P4 | Deep lane wiring, DecidePort + adapters, intent/lane routing | T4, T9 pass; panel fills after fast answer |
| P5 | Lessons, plan panel, question dock, explain-back | T8, T14 pass |
| P6 | Graph pipeline, Graph home, chain table | T5, T6 pass |
| P7 | Cards, FSRS, Review page, pill badge and card state, session-end recap | T7 passes |
| P8 | MCP server, web research job, anchor pin/confirm, `local_only`, DND | T2, T3, T10, T12 pass |

---

## 15. MCP Server (`mcp/server.ts`)

Stdio server launched by `bun run sidecar mcp`; connects to the daemon with the daemon token from `.run/token`.

```ts
tutor_ask({ question: string; topic_hint?: string;
  context?: { files?: string[]; diff_summary?: string; what_agent_did?: string } })
  -> { status: "sent"; ticket: string }          // answer goes to pill + panel only

tutor_note({ concept: string; source_ref?: string; why?: string })
  -> { status: "noted" }                          // queued for recap / card candidates
```

Also expose an MCP prompt named `tutor` with argument `question` that calls `tutor_ask`.

Registration examples (document in README):

```sh
claude mcp add study-sidecar -- bun run sidecar mcp
```

---

## 16. Complex Topics (research, LLM training, math-heavy)

- **Measure first, always** for a new lesson: 3 to 6 quick probes (quiz + think-aloud) produce `lesson.measure`; the plan starts where understanding ends.
- **Plan is a prerequisite DAG** authored once via `plan_init`; gaps not needed for the goal are queued, not chased.
- **Multiple anchors per lesson**: code lines, run logs (`kind: "run"`, tool `read_run_metrics(path, metric, every_n)` returns a downsampled series, max 200 points), papers/PDFs (page + quote), URLs.
- **Background jobs** (ack-and-continue): `research` (web search + fetch, cited), `read_paper` (PDF section summary with page refs). Results stream into the lesson and Sources rail.
- **Grounding rule**: explanations reference the learner's own variable names, metrics, and run numbers whenever an anchor provides them.
- Interactive demos and practice problem sets are Deferred (Section 3.2).

## 17. Copy and Behavior Rules for the Tutor

- One concept per turn. Queue prerequisite gaps; do not chase them.
- Use the learner's own names and code from the anchor when giving examples.
- Never claim a concept is learned without a passed recall or explain-back.
- Every web-derived fact carries a `SourceRef`. No uncited facts in cards.
- Spoken output never reads code aloud.
