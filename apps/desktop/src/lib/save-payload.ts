import { extractMermaid } from "./mermaid";
import type { SessionEvent } from "./protocol";

export type ConceptPayload = {
	title: string;
	body: string;
	mermaid?: string;
	tool_use_id?: string;
	session_file?: string;
};

function toolCallId(event: SessionEvent): string | undefined {
	if (
		!("metadata" in event) ||
		!event.metadata ||
		typeof event.metadata !== "object"
	)
		return undefined;
	if (
		!("tool_call_id" in event.metadata) ||
		typeof event.metadata.tool_call_id !== "string"
	)
		return undefined;
	return event.metadata.tool_call_id;
}

const TITLE_LIMIT = 80;
const BODY_LIMIT = 20_000;

/** Build the /okf/save payload from the last tutor exchange; null when there is no answer yet. */
export function buildSavePayload(
	questions: string[],
	answers: string[],
	events: SessionEvent[] = [],
): ConceptPayload | null {
	const body = answers.at(-1)?.trim();
	if (!body) return null;
	const question = questions.at(-1)?.trim() ?? "";
	const toolCall = [...events]
		.reverse()
		.find((event) => event.event_type === "tool_call");
	const sessionFile = [...events]
		.reverse()
		.find((event) => event.session_file)?.session_file;
	const mermaid = extractMermaid(body)[0];
	const toolUseId = toolCall ? toolCallId(toolCall) : undefined;
	return {
		title: (question || body).slice(0, TITLE_LIMIT),
		body: body.slice(0, BODY_LIMIT),
		...(mermaid ? { mermaid } : {}),
		...(toolUseId ? { tool_use_id: toolUseId } : {}),
		...(sessionFile ? { session_file: sessionFile } : {}),
	};
}
