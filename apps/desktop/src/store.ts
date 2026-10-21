import type {
	DaemonMessage,
	Mode,
	SessionEvent,
	TutorDocuments,
} from "./lib/protocol";

export type { DaemonMessage, Mode, SessionEvent };

export type Insight = {
	kind: "ambient" | "guardrail" | "dead_air";
	text: string;
	command?: string;
};

export type DesktopError = { scope: string; message: string };

export type DesktopState = {
	events: SessionEvent[];
	insights: Insight[];
	prompts: string[];
	questions: string[];
	pendingQuestions: string[];
	answers: string[];
	errors: DesktopError[];
	modes: Mode[];
	activeMode: string;
	session?: {
		id?: string;
		project?: string;
		goal?: string;
		session_file?: string;
	};
	documents?: TutorDocuments;
};

export const initialDesktopState: DesktopState = {
	events: [],
	insights: [],
	prompts: [],
	questions: [],
	pendingQuestions: [],
	answers: [],
	errors: [],
	modes: [],
	activeMode: "",
};

const append = <T>(items: T[], item: T, limit = 100): T[] =>
	[...items, item].slice(-limit);

export function reduceDaemonMessage(
	state: DesktopState,
	message: DaemonMessage,
): DesktopState {
	switch (message.type) {
		case "session_init": {
			const nextSession = {
				id: message.session_id,
				project: message.project_name,
				goal: message.current_goal,
				session_file: message.transcript_path,
			};
			// Only a real session change wipes the conversation; a reconnect
			// replaying the same session keeps it.
			const changed =
				state.session?.id !== nextSession.id ||
				state.session?.session_file !== nextSession.session_file;
			return {
				...state,
				...(changed
					? {
							questions: [],
							pendingQuestions: [],
							answers: [],
							insights: [],
							prompts: [],
						}
					: {}),
				events: message.events,
				errors: [],
				session: nextSession,
			};
		}
		case "new_event":
			return { ...state, events: append(state.events, message.event) };
		case "ambient_insight":
		case "dead_air_insight": {
			const command =
				message.type === "dead_air_insight" ? message.command : undefined;
			const kind = message.type === "ambient_insight" ? "ambient" : "dead_air";
			return message.insight
				? {
						...state,
						insights: append(
							state.insights,
							{
								kind,
								text: message.insight,
								...(command ? { command } : {}),
							},
							20,
						),
					}
				: state;
		}
		case "guardrail":
			return message.findings?.length
				? {
						...state,
						insights: append(
							state.insights,
							{ kind: "guardrail", text: message.findings.join("\n") },
							20,
						),
					}
				: state;
		case "steering_prompt":
			return message.prompt
				? { ...state, prompts: append(state.prompts, message.prompt, 20) }
				: state;
		case "modes":
			return { ...state, modes: message.modes, activeMode: message.active };
		case "tutor_answer":
			return message.answer
				? {
						...state,
						answers: append(state.answers, message.answer, 50),
						pendingQuestions: [],
					}
				: state;
		case "daemon_error":
			return {
				...state,
				...(message.scope === "provider" ? { pendingQuestions: [] } : {}),
				errors: append(
					state.errors,
					{
						scope: message.scope,
						message: message.message,
					},
					10,
				),
			};
		case "error":
			return {
				...state,
				errors: append(
					state.errors,
					{ scope: "daemon", message: message.message },
					10,
				),
			};
		case "mode_changed":
			return { ...state, activeMode: message.name };
		case "tutor_documents":
			return { ...state, documents: message.documents };
		default:
			return state;
	}
}

export function nextReconnectDelay(attempt: number): number {
	return Math.min(500 * 2 ** attempt, 4_000);
}
