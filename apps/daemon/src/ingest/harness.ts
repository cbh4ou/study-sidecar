import { sieveToolResult } from "../sieve/tier0.ts";
import type { SessionEvent, SessionInfo } from "./events.ts";

type Normalized = { events: SessionEvent[]; session?: SessionInfo };
const at = (value: unknown) =>
	typeof value === "string" && !Number.isNaN(Date.parse(value))
		? value
		: new Date().toISOString();
const line = (text: string) =>
	text.trim().split(/\r?\n/, 1)[0]?.slice(0, 100) ?? "";
const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const items = (value: unknown) =>
	Array.isArray(value)
		? value.flatMap((item) => (object(item) ? [item] : []))
		: [];
const contentText = (value: unknown) =>
	typeof value === "string"
		? value
		: items(value)
				.map((item) => (typeof item.text === "string" ? item.text : ""))
				.filter(Boolean)
				.join(" ");

function toolCall(
	timestamp: string,
	name: string,
	input: unknown,
	id?: unknown,
): SessionEvent {
	const raw = typeof input === "string" ? input : JSON.stringify(input ?? {});
	const lower = name.toLowerCase();
	const toolName =
		lower.includes("bash") || lower.includes("exec")
			? "Bash"
			: lower.includes("write")
				? "Write"
				: lower.includes("edit")
					? "Edit"
					: name;
	const command =
		typeof input === "object" &&
		input &&
		"command" in input &&
		typeof input.command === "string"
			? input.command
			: raw.match(/(?:cmd|command)[:=]\s*["']?([^"'\n}]+)/)?.[1];
	return {
		timestamp,
		event_type: "tool_call",
		headline: command
			? `Run: \`${command.slice(0, 80)}\``
			: `Execute: ${toolName}`,
		details: raw,
		tool_name: toolName,
		metadata: { tool_call_id: id },
	};
}

export function normalizeCodexRecord(value: unknown): Normalized {
	const record = object(value);
	if (!record) return { events: [] };
	const timestamp = at(record.timestamp);
	const payload = object(record.payload);
	if (record.type === "session_meta") {
		const cwd =
			typeof payload?.cwd === "string"
				? payload.cwd
				: typeof record.cwd === "string"
					? record.cwd
					: undefined;
		const id =
			typeof payload?.session_id === "string"
				? payload.session_id
				: typeof record.session_id === "string"
					? record.session_id
					: "codex-session";
		return {
			events: [],
			session: { id, project_name: cwd?.split("/").pop(), cwd },
		};
	}
	if (record.type !== "response_item" || !payload) return { events: [] };
	if (payload.type === "message") {
		const role = payload.role;
		const text = contentText(payload.content);
		if (!text.trim() || text.includes("<environment_context>"))
			return { events: [] };
		const eventType = role === "user" ? "user_task" : "agent_message";
		return {
			events: [
				{
					timestamp,
					event_type: eventType,
					headline: `${role === "user" ? "User" : "Codex"}: ${line(text)}`,
					details: text,
				},
			],
		};
	}
	if (payload.type === "reasoning")
		return {
			events: [
				{
					timestamp,
					event_type: "agent_thought",
					headline: "Codex: Analyzing context & planning execution...",
					details:
						typeof payload.text === "string"
							? payload.text
							: "Model reasoning phase.",
				},
			],
		};
	if (payload.type === "custom_tool_call")
		return {
			events: [
				toolCall(
					timestamp,
					typeof payload.name === "string" ? payload.name : "tool",
					payload.input,
					payload.call_id,
				),
			],
		};
	if (payload.type === "custom_tool_call_output") {
		const output = contentText(payload.output);
		return {
			events: [
				{
					timestamp,
					event_type: "tool_result",
					headline: `Result: ${line(output) || "Empty output"}`,
					details: sieveToolResult("bash", output),
					metadata: { tool_call_id: payload.call_id },
				},
			],
		};
	}
	return { events: [] };
}

export function normalizeClaudeRecord(value: unknown): Normalized {
	const record = object(value);
	if (!record) return { events: [] };
	const timestamp = at(record.timestamp);
	const message = object(record.message);
	if (
		record.type === "queue-operation" &&
		record.operation === "enqueue" &&
		typeof record.content === "string"
	)
		return {
			events: [
				{
					timestamp,
					event_type: "user_task",
					headline: `User: ${line(record.content)}`,
					details: record.content,
				},
			],
		};
	if ((record.type !== "assistant" && record.type !== "user") || !message)
		return { events: [] };
	const content = message.content;
	if (record.type === "user" && typeof content === "string" && content.trim())
		return {
			events: [
				{
					timestamp,
					event_type: "user_task",
					headline: `User: ${line(content)}`,
					details: content,
				},
			],
		};
	const events: SessionEvent[] = [];
	for (const item of items(content)) {
		if (
			record.type === "assistant" &&
			item.type === "thinking" &&
			typeof item.thinking === "string"
		)
			events.push({
				timestamp,
				event_type: "agent_thought",
				headline: `Thought: ${line(item.thinking)}`,
				details: item.thinking,
			});
		else if (
			record.type === "assistant" &&
			item.type === "text" &&
			typeof item.text === "string"
		)
			events.push({
				timestamp,
				event_type: "agent_message",
				headline: `Agent: ${line(item.text)}`,
				details: item.text,
			});
		else if (record.type === "assistant" && item.type === "tool_use")
			events.push(
				toolCall(
					timestamp,
					typeof item.name === "string" ? item.name : "tool",
					item.input,
					item.id,
				),
			);
		else if (record.type === "user" && item.type === "tool_result") {
			const text = contentText(item.content);
			events.push({
				timestamp,
				event_type: "tool_result",
				headline: `${item.is_error ? "Error" : "Result"}: ${line(text) || "Empty output"}`,
				details: sieveToolResult("bash", text),
				is_error: Boolean(item.is_error),
				metadata: { tool_call_id: item.tool_use_id },
			});
		}
	}
	return { events };
}
