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
	| { type: "error"; message: string };

/** Messages desktop clients send to the daemon. */
export type ClientMessage =
	| { type: "question"; text: string }
	| { type: "set_mode"; name: string };

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
		default:
			return undefined;
	}
}
