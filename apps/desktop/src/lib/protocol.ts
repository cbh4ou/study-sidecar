// GENERATED from apps/daemon/src/protocol.ts — do not edit by hand.
// Regenerate with `bun run gen-protocol`; the drift test enforces byte-identity.

/**
 * Canonical daemon WebSocket protocol. This file is self-contained and copied
 * verbatim (plus a generated header) into apps/desktop/src/lib/protocol.ts by
 * `bun run gen-protocol`; the protocol drift test enforces byte-identity.
 */

export type SessionEvent = {
	timestamp: string;
	headline: string;
	details: string;
	event_type: string;
	id?: string;
	parent_id?: string;
	session_file?: string;
	diff?: string;
	bash_tail?: string;
	signals?: string[];
	dead_air?: boolean;
	tool_name?: string;
	is_error?: boolean;
};

export type Mode = {
	name: string;
	title: string;
	description: string;
	voice_profile?: string;
};

export type TutorDocuments = {
	hud_state: {
		status: "idle" | "thinking" | "speaking" | "error";
		mode: string;
		message: string;
	};
	scratchpad_diagram: { diagram: string };
	socratic_quiz: {
		question: string;
		options: Array<{ id: string; label: string }>;
		correctId?: string;
	};
	steering_prompt: { prompt: string };
	research_scratchpad: { name: string; content: string };
	tutor_trace: Array<{
		label: string;
		detail: string;
		status: "running" | "ok" | "error";
	}>;
};

/** Where a fact, anchor, or card came from. */
export type SourceRef =
	| {
			kind: "session";
			harness: string;
			sessionId: string;
			turnId?: string;
			file?: string;
			lines?: [number, number];
	  }
	| { kind: "file"; path: string; lines?: [number, number] }
	| { kind: "web"; url: string; quote?: string }
	| { kind: "pdf"; path: string; page: number; quote?: string }
	| { kind: "lesson"; lessonId: string; messageId: string }
	| { kind: "run"; path: string; metric?: string; step?: number };

export type Question =
	| {
			kind: "quiz";
			id: string;
			prompt: string;
			options: Array<{ id: string; label: string }>;
			correctId: string;
			planNode?: string;
	  }
	| { kind: "ask"; id: string; prompt: string }
	| {
			kind: "explain_back";
			id: string;
			prompt: string;
			expectedPropositions: string[];
	  };

export type ReviewRating = "again" | "hard" | "good" | "easy";

export type Card = {
	id: string;
	propositionId: string;
	question: string;
	example?: string;
	source: SourceRef;
	createdAt: string;
};

export type TurnTelemetry = {
	stt_ms?: number;
	decide_ms?: number;
	decide_adapter?: string;
	packet_tokens: number;
	fast_ttft_ms?: number;
	tts_first_audio_ms?: number;
	deep_total_ms?: number;
};

export type ActivityJob = {
	id: string;
	kind: "deep" | "research" | "extraction" | "recap";
	label: string;
	status: "queued" | "running" | "done" | "error";
};

export type TurnSource = "ptt" | "typed" | "mcp";

/* ---- HTTP wire shapes (daemon REST API, consumed by desktop) ---- */

export type Proposition = {
	id: string;
	name: string;
	statement: string;
	aliases?: string[];
	sources: SourceRef[];
	createdAt: string;
	birthSource: string;
};

export type Chain = {
	id: string;
	premises: string[];
	conclusion: string;
	createdAt: string;
	sources: SourceRef[];
};

/** GET /api/graph: derived view; implication ids equal chain ids. */
export type GraphSnapshot = {
	nodes: Proposition[];
	chains: Chain[];
	implications: Array<{ id: string; premises: string[]; conclusion: string }>;
	groups: Array<{ key: string; label: string | null; nodeIds: string[] }>;
};

export type LessonPhase = "measure" | "plan" | "teach";
export type MeasureLevel = "solid" | "shaky" | "new";
export type PlanStatus = "current" | "visited" | "upcoming";

export type Lesson = {
	id: string;
	title: string;
	goal: string;
	anchors: SourceRef[];
	measure?: Record<string, MeasureLevel>;
	phase: LessonPhase;
	planMermaid?: string;
	sessionPath?: string;
	createdAt: string;
	updatedAt: string;
};

export type LessonMessage = {
	id: string;
	role: "tutor" | "learner";
	kind: "text" | "think_aloud";
	text: string;
	at: string;
};

export type LessonDetail = Lesson & {
	messages: LessonMessage[];
	questions: Question[];
	answers: Record<
		string,
		{ value: string; correct?: boolean; verdict?: string }
	>;
	planNodes: Array<{ id: string; label: string; status: PlanStatus }>;
	queuedGaps: string[];
	sources: SourceRef[];
};

export type SessionSummary = {
	path: string;
	harness: string;
	project?: string;
	modified: number;
	live: boolean;
	localOnly: boolean;
	indexGraph: boolean;
	bound: boolean;
	noteCount: number;
};

export type SessionDetail = {
	summary: SessionSummary;
	receipts: Array<{
		at: string;
		text: string;
		kind: string;
		isError?: boolean;
	}>;
	notes: Array<{ concept: string; why?: string; at: string }>;
	concepts: Array<{ id: string; name: string }>;
	anchors: SourceRef[];
};

export type TelemetryEntry = TurnTelemetry & { turnId: string; at: number };

export type SidecarSettings = {
	lanes: { fast?: string; deep?: string };
	decide: {
		adapter: "auto" | "jev" | "llm" | "rules";
		threshold: number;
		jevConfigured: boolean;
	};
	web: { provider: "none" | "brave" | "tavily"; configured: boolean };
	voice: { mode: "ptt" | "vad"; stt?: string; tts?: string };
	privacy: { defaultLocalOnly: boolean };
	follow: boolean;
};

export type DaemonErrorScope = "insight" | "dead_air" | "steering" | "provider";

/** Messages the daemon sends to desktop clients. */
export type DaemonMessage =
	| {
			type: "session_init";
			session_id?: string;
			project_name?: string;
			current_goal?: string;
			transcript_path?: string;
			events: SessionEvent[];
	  }
	| { type: "new_event"; event: SessionEvent }
	| { type: "ambient_insight"; insight?: string }
	| { type: "guardrail"; findings?: string[] }
	| {
			type: "dead_air_insight";
			insight?: string;
			command?: string;
	  }
	| {
			type: "tutor_answer";
			answer?: string;
			mermaid?: string;
			voice?: { language?: string; speed?: number; voice?: string };
	  }
	| { type: "steering_prompt"; prompt?: string }
	| { type: "mode_changed"; name: string }
	| { type: "modes"; modes: Mode[]; active: string }
	| { type: "tutor_documents"; documents: TutorDocuments }
	| { type: "daemon_error"; scope: DaemonErrorScope; message: string }
	| { type: "error"; message: string }
	| { type: "turn_started"; turnId: string; source: TurnSource }
	| { type: "transcript"; turnId: string; text: string; final: boolean }
	/** One spoken sentence of the fast lane; clients append and speak each. */
	| { type: "fast_answer"; turnId: string; text: string }
	| {
			type: "deep_update";
			turnId: string;
			documents: Partial<TutorDocuments>;
	  }
	| { type: "turn_settled"; turnId: string; telemetry: TurnTelemetry }
	| { type: "question"; lessonId?: string; question: Question }
	| { type: "cards_due"; count: number }
	| { type: "card_prompt"; card: Card }
	| { type: "anchor_suggest"; anchor: SourceRef; preview: string }
	| { type: "graph_changed" }
	| { type: "lessons_changed" }
	| { type: "sessions_changed" }
	| { type: "bound_session"; sessionPath: string; follow: boolean }
	| { type: "activity"; jobs: ActivityJob[] };

/** Messages desktop clients send to the daemon. */
export type ClientMessage =
	| {
			type: "question";
			text: string;
			/** How the question arrived; defaults to "typed". */
			source?: TurnSource;
			/** Classroom lesson the question belongs to. */
			lessonId?: string;
			/** Client-measured speech-to-text latency for PTT turns. */
			sttMs?: number;
	  }
	| { type: "set_mode"; name: string }
	| { type: "ptt_start" }
	| { type: "ptt_stop" }
	| { type: "interrupt" }
	| { type: "answer"; questionId: string; value: string }
	| { type: "grade"; cardId: string; rating: ReviewRating }
	| { type: "anchor_confirm"; accept: boolean }
	| { type: "bind_session"; sessionPath: string | null }
	| { type: "dnd"; on: boolean }
	| { type: "abort_job"; jobId: string };

/** Emissions the tutor engine itself can produce. */
export type TutorEmit = Extract<
	DaemonMessage,
	{
		type:
			| "ambient_insight"
			| "guardrail"
			| "dead_air_insight"
			| "tutor_answer"
			| "steering_prompt"
			| "tutor_documents"
			| "daemon_error";
	}
>;

/** Canonical object guard for protocol values; fields remain `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTutorDocuments(value: unknown): value is TutorDocuments {
	if (!isRecord(value)) return false;
	const hud = value.hud_state;
	const diagram = value.scratchpad_diagram;
	const quiz = value.socratic_quiz;
	const prompt = value.steering_prompt;
	const scratchpad = value.research_scratchpad;
	const trace = value.tutor_trace;
	return (
		isRecord(hud) &&
		["idle", "thinking", "speaking", "error"].includes(String(hud.status)) &&
		typeof hud.mode === "string" &&
		typeof hud.message === "string" &&
		isRecord(diagram) &&
		typeof diagram.diagram === "string" &&
		isRecord(quiz) &&
		typeof quiz.question === "string" &&
		Array.isArray(quiz.options) &&
		quiz.options.every(
			(option) =>
				isRecord(option) &&
				typeof option.id === "string" &&
				typeof option.label === "string",
		) &&
		(quiz.correctId === undefined || typeof quiz.correctId === "string") &&
		isRecord(prompt) &&
		typeof prompt.prompt === "string" &&
		isRecord(scratchpad) &&
		typeof scratchpad.name === "string" &&
		typeof scratchpad.content === "string" &&
		Array.isArray(trace) &&
		trace.every(
			(item) =>
				isRecord(item) &&
				typeof item.label === "string" &&
				typeof item.detail === "string" &&
				["running", "ok", "error"].includes(String(item.status)),
		)
	);
}

const isEvent = (value: unknown): value is SessionEvent =>
	isRecord(value) &&
	typeof value.timestamp === "string" &&
	typeof value.headline === "string" &&
	typeof value.details === "string" &&
	typeof value.event_type === "string" &&
	(value.id === undefined || typeof value.id === "string") &&
	(value.parent_id === undefined || typeof value.parent_id === "string") &&
	(value.session_file === undefined ||
		typeof value.session_file === "string") &&
	(value.diff === undefined || typeof value.diff === "string") &&
	(value.bash_tail === undefined || typeof value.bash_tail === "string") &&
	(value.signals === undefined ||
		(Array.isArray(value.signals) &&
			value.signals.every((signal) => typeof signal === "string"))) &&
	(value.dead_air === undefined || typeof value.dead_air === "boolean");

function isQuestion(value: unknown): value is Question {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.prompt !== "string"
	)
		return false;
	if (value.kind === "ask") return true;
	if (value.kind === "explain_back")
		return (
			Array.isArray(value.expectedPropositions) &&
			value.expectedPropositions.every((id) => typeof id === "string")
		);
	return (
		value.kind === "quiz" &&
		typeof value.correctId === "string" &&
		Array.isArray(value.options) &&
		value.options.every(
			(option) =>
				isRecord(option) &&
				typeof option.id === "string" &&
				typeof option.label === "string",
		)
	);
}

/** Validate an unknown value as a client-to-daemon message, or undefined. */
export function parseClientMessage(value: unknown): ClientMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "question":
			return typeof value.text === "string" &&
				value.text.trim() &&
				(value.source === undefined ||
					(["ptt", "typed", "mcp"] as const).includes(
						value.source as TurnSource,
					)) &&
				(value.lessonId === undefined || typeof value.lessonId === "string") &&
				(value.sttMs === undefined || typeof value.sttMs === "number")
				? (value as ClientMessage)
				: undefined;
		case "set_mode":
			return typeof value.name === "string"
				? (value as ClientMessage)
				: undefined;
		case "ptt_start":
		case "ptt_stop":
		case "interrupt":
			return value as ClientMessage;
		case "answer":
			return typeof value.questionId === "string" &&
				typeof value.value === "string"
				? (value as ClientMessage)
				: undefined;
		case "grade":
			return typeof value.cardId === "string" &&
				(["again", "hard", "good", "easy"] as const).includes(
					value.rating as ReviewRating,
				)
				? (value as ClientMessage)
				: undefined;
		case "anchor_confirm":
			return typeof value.accept === "boolean"
				? (value as ClientMessage)
				: undefined;
		case "bind_session":
			return value.sessionPath === null || typeof value.sessionPath === "string"
				? (value as ClientMessage)
				: undefined;
		case "dnd":
			return typeof value.on === "boolean"
				? (value as ClientMessage)
				: undefined;
		case "abort_job":
			return typeof value.jobId === "string"
				? (value as ClientMessage)
				: undefined;
		default:
			return undefined;
	}
}

/** Validate an unknown value as a daemon-to-client message, or undefined. */
export function parseDaemonMessage(value: unknown): DaemonMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "session_init":
			return (value.session_id === undefined ||
				typeof value.session_id === "string") &&
				(value.project_name === undefined ||
					typeof value.project_name === "string") &&
				(value.current_goal === undefined ||
					typeof value.current_goal === "string") &&
				(value.transcript_path === undefined ||
					typeof value.transcript_path === "string") &&
				Array.isArray(value.events) &&
				value.events.every((event) => isEvent(event))
				? (value as DaemonMessage)
				: undefined;
		case "new_event":
			return isEvent(value.event) ? (value as DaemonMessage) : undefined;
		case "ambient_insight":
			return value.insight === undefined || typeof value.insight === "string"
				? (value as DaemonMessage)
				: undefined;
		case "guardrail":
			return value.findings === undefined ||
				(Array.isArray(value.findings) &&
					value.findings.every((finding) => typeof finding === "string"))
				? (value as DaemonMessage)
				: undefined;
		case "dead_air_insight":
			return (value.insight === undefined ||
				typeof value.insight === "string") &&
				(value.command === undefined || typeof value.command === "string")
				? (value as DaemonMessage)
				: undefined;
		case "tutor_answer":
			return (value.answer === undefined || typeof value.answer === "string") &&
				(value.mermaid === undefined || typeof value.mermaid === "string") &&
				(value.voice === undefined ||
					(isRecord(value.voice) &&
						(value.voice.language === undefined ||
							typeof value.voice.language === "string") &&
						(value.voice.speed === undefined ||
							typeof value.voice.speed === "number") &&
						(value.voice.voice === undefined ||
							typeof value.voice.voice === "string")))
				? (value as DaemonMessage)
				: undefined;
		case "steering_prompt":
			return value.prompt === undefined || typeof value.prompt === "string"
				? (value as DaemonMessage)
				: undefined;
		case "mode_changed":
			return typeof value.name === "string"
				? (value as DaemonMessage)
				: undefined;
		case "modes":
			return Array.isArray(value.modes) &&
				value.modes.every(
					(mode) =>
						isRecord(mode) &&
						typeof mode.name === "string" &&
						typeof mode.title === "string" &&
						typeof mode.description === "string",
				) &&
				typeof value.active === "string"
				? (value as DaemonMessage)
				: undefined;
		case "tutor_documents":
			return isTutorDocuments(value.documents)
				? (value as DaemonMessage)
				: undefined;
		case "daemon_error":
			return (
				["insight", "dead_air", "steering", "provider"] as const
			).includes(value.scope as DaemonErrorScope) &&
				typeof value.message === "string"
				? (value as DaemonMessage)
				: undefined;
		case "error":
			return typeof value.message === "string"
				? (value as DaemonMessage)
				: undefined;
		case "turn_started":
			return typeof value.turnId === "string" &&
				(["ptt", "typed", "mcp"] as const).includes(value.source as TurnSource)
				? (value as DaemonMessage)
				: undefined;
		case "transcript":
			return typeof value.turnId === "string" &&
				typeof value.text === "string" &&
				typeof value.final === "boolean"
				? (value as DaemonMessage)
				: undefined;
		case "fast_answer":
			return typeof value.turnId === "string" && typeof value.text === "string"
				? (value as DaemonMessage)
				: undefined;
		case "deep_update":
			return typeof value.turnId === "string" && isRecord(value.documents)
				? (value as DaemonMessage)
				: undefined;
		case "turn_settled":
			return typeof value.turnId === "string" &&
				isRecord(value.telemetry) &&
				typeof value.telemetry.packet_tokens === "number"
				? (value as DaemonMessage)
				: undefined;
		case "question":
			return (value.lessonId === undefined ||
				typeof value.lessonId === "string") &&
				isQuestion(value.question)
				? (value as DaemonMessage)
				: undefined;
		case "cards_due":
			return typeof value.count === "number"
				? (value as DaemonMessage)
				: undefined;
		case "card_prompt":
			return isRecord(value.card) &&
				typeof value.card.id === "string" &&
				typeof value.card.question === "string"
				? (value as DaemonMessage)
				: undefined;
		case "anchor_suggest":
			return isRecord(value.anchor) &&
				typeof value.anchor.kind === "string" &&
				typeof value.preview === "string"
				? (value as DaemonMessage)
				: undefined;
		case "graph_changed":
		case "lessons_changed":
		case "sessions_changed":
			return value as DaemonMessage;
		case "bound_session":
			return typeof value.sessionPath === "string" &&
				typeof value.follow === "boolean"
				? (value as DaemonMessage)
				: undefined;
		case "activity":
			return Array.isArray(value.jobs) &&
				value.jobs.every(
					(job) =>
						isRecord(job) &&
						typeof job.id === "string" &&
						typeof job.label === "string" &&
						typeof job.kind === "string" &&
						typeof job.status === "string",
				)
				? (value as DaemonMessage)
				: undefined;
		default:
			return undefined;
	}
}
