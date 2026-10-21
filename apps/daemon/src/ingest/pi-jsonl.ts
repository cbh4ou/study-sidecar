import { type Stats, stat } from "node:fs/promises";
import {
	detectAntipatterns,
	diffExcerpt,
	sieveToolResult,
} from "../sieve/tier0.ts";
import type { SessionEvent, SessionInfo, TailerCallbacks } from "./events.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const decoder = new TextDecoder();

type PiContent = {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	id?: unknown;
};
type PiMessage = {
	role?: string;
	content?: unknown;
	timestamp?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	durationMs?: unknown;
	isError?: unknown;
};

type PiRecord = { type?: string; message?: PiMessage; [key: string]: unknown };

function timestamp(value: unknown): string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value))
		? value
		: new Date().toISOString();
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC control character is exactly what is being stripped
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** Harness transcripts carry terminal color codes; the HUD renders plain text. */
const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "");

function firstLine(text: string, limit = 100): string {
	return stripAnsi(text.trim().split(/\r?\n/, 1)[0] ?? "").slice(0, limit);
}

function contentItems(value: unknown): PiContent[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is PiContent => typeof item === "object" && item !== null,
			)
		: [];
}

function textFromContent(content: unknown): string {
	return stripAnsi(
		contentItems(content)
			.map((item) => (typeof item.text === "string" ? item.text : ""))
			.filter(Boolean)
			.join(" "),
	);
}

export function affectedSymbol(...texts: string[]): string | undefined {
	for (const text of texts) {
		const match =
			/^\s*((?:async\s+)?def\s+\w+|class\s+\w+|(?:const|let|var|function)\s+\w+)/m.exec(
				text,
			);
		if (match) return match[1];
	}
	return undefined;
}

function toolCallEvent(item: PiContent, eventTimestamp: string): SessionEvent {
	const rawName = typeof item.name === "string" ? item.name : "unknown";
	const arguments_ =
		typeof item.arguments === "object" && item.arguments !== null
			? (item.arguments as Record<string, unknown>)
			: {};
	const normalizedName = rawName.toLowerCase();
	const labels: Record<string, string> = {
		bash: "Bash",
		read: "Read",
		write: "Write",
		edit: "Edit",
		strreplace: "Edit",
		grep: "Grep",
		search: "Grep",
		glob: "Glob",
		findfiles: "Glob",
	};
	const toolName =
		labels[normalizedName] ??
		`${rawName.slice(0, 1).toUpperCase()}${rawName.slice(1)}`;
	const filePath =
		typeof arguments_.path === "string"
			? arguments_.path
			: typeof arguments_.file_path === "string"
				? arguments_.file_path
				: undefined;
	let headline = `Execute: ${toolName}`;
	let details = JSON.stringify(arguments_, null, 2);
	if (toolName === "Bash") {
		const command =
			typeof arguments_.command === "string" ? arguments_.command : "";
		headline = command
			? `Run: \`${command.slice(0, 80)}\``
			: "Run bash command";
		details = command;
	} else if (toolName === "Read")
		headline = filePath ? `Read: ${filePath}` : "Read file";
	else if (toolName === "Write") {
		const content =
			typeof arguments_.content === "string" ? arguments_.content : "";
		headline = filePath ? `@@ new file: ${filePath}` : "Write file";
		if (content) details = diffExcerpt(content);
	} else if (toolName === "Edit") {
		const oldText =
			typeof arguments_.oldString === "string"
				? arguments_.oldString
				: typeof arguments_.old_string === "string"
					? arguments_.old_string
					: "";
		const newText =
			typeof arguments_.newString === "string"
				? arguments_.newString
				: typeof arguments_.new_string === "string"
					? arguments_.new_string
					: "";
		const symbol = affectedSymbol(newText, oldText);
		headline = filePath
			? `@@ ${filePath}${symbol ? ` :: ${symbol}` : ""}`
			: "Edit file";
		if (oldText || newText)
			details = diffExcerpt(
				`@@ edit ${filePath ?? ""}\n${oldText
					.split(/\r?\n/)
					.map((line) => `-${line}`)
					.join("\n")}\n${newText
					.split(/\r?\n/)
					.map((line) => `+${line}`)
					.join("\n")}`,
			);
	} else if (toolName === "Grep")
		headline = `Search: \`${String(arguments_.pattern ?? "")}\``;
	else if (toolName === "Glob")
		headline = `Find: pattern \`${String(arguments_.pattern ?? "*")}\``;
	return {
		timestamp: eventTimestamp,
		event_type: "tool_call",
		headline,
		details,
		tool_name: toolName,
		file_path: filePath,
		metadata: { tool_call_id: item.id },
	};
}

export function normalizePiRecord(record: PiRecord): {
	events: SessionEvent[];
	session?: SessionInfo;
} {
	if (record.type === "session") {
		const id = record.id ?? record.sessionId ?? record.session_id;
		return typeof id === "string"
			? {
					events: [],
					session: {
						id,
						project_name:
							typeof record.project === "string" ? record.project : undefined,
						current_goal:
							typeof record.goal === "string" ? record.goal : undefined,
						cwd: typeof record.cwd === "string" ? record.cwd : undefined,
					},
				}
			: { events: [] };
	}
	if (record.type !== "message" || !record.message) return { events: [] };
	const message = record.message;
	const eventTimestamp = timestamp(message.timestamp ?? record.timestamp);
	const content = message.content;
	if (message.role === "user") {
		const text =
			typeof content === "string" ? content : textFromContent(content);
		return text.trim()
			? {
					events: [
						{
							timestamp: eventTimestamp,
							event_type: "user_task",
							headline: `User: ${firstLine(text, 80)}`,
							details: text,
						},
					],
				}
			: { events: [] };
	}
	if (message.role === "assistant") {
		const events = contentItems(content).flatMap((item): SessionEvent[] => {
			if (
				item.type === "thinking" &&
				typeof item.thinking === "string" &&
				item.thinking.trim()
			)
				return [
					{
						timestamp: eventTimestamp,
						event_type: "agent_thought",
						headline: `Thought: ${firstLine(item.thinking)}`,
						details: stripAnsi(item.thinking),
					},
				];
			if (
				item.type === "text" &&
				typeof item.text === "string" &&
				item.text.trim()
			)
				return [
					{
						timestamp: eventTimestamp,
						event_type: "agent_message",
						headline: `Agent: ${firstLine(item.text)}`,
						details: stripAnsi(item.text),
					},
				];
			return item.type === "toolCall"
				? [toolCallEvent(item, eventTimestamp)]
				: [];
		});
		return { events };
	}
	if (message.role === "toolResult") {
		const text = textFromContent(content);
		const toolName =
			typeof message.toolName === "string" ? message.toolName : "unknown";
		const details = sieveToolResult(toolName, text);
		const isError = Boolean(message.isError);
		return {
			events: [
				{
					timestamp: eventTimestamp,
					event_type: "tool_result",
					headline: `${isError ? "Error" : "Result"}: ${firstLine(details) || "Empty output"}`,
					details,
					tool_name: `${toolName.slice(0, 1).toUpperCase()}${toolName.slice(1)}`,
					is_error: isError,
					metadata: {
						tool_call_id: message.toolCallId,
						duration_ms: message.durationMs,
					},
				},
			],
		};
	}
	return { events: [] };
}

type Normalizer = (record: PiRecord) => {
	events: SessionEvent[];
	session?: SessionInfo;
};

export type EventEnrichmentState = {
	file?: string;
	seq: () => number;
};

export function enrichEvent(
	event: SessionEvent,
	state: EventEnrichmentState,
): SessionEvent {
	const tool = event.tool_name?.toLowerCase();
	const diff =
		event.event_type === "tool_call" && ["write", "edit"].includes(tool ?? "")
			? event.details
			: undefined;
	const bashTail =
		event.event_type === "tool_result" && tool === "bash"
			? event.details.split(/\r?\n/).slice(-8).join("\n")
			: undefined;
	const signals = detectAntipatterns(event.details);
	return {
		...event,
		id: `${event.timestamp}:${state.seq()}`,
		...(state.file ? { session_file: state.file } : {}),
		...(diff ? { diff } : {}),
		...(bashTail ? { bash_tail: bashTail } : {}),
		...(signals.length ? { signals } : {}),
	};
}

export class PiTailer {
	#offset = 0;
	#fragment = new Uint8Array();
	#identity?: string;
	#eventCounter = 0;
	#enrichment: EventEnrichmentState;
	constructor(
		readonly path: string,
		private readonly callbacks: TailerCallbacks,
		private readonly normalize: Normalizer = normalizePiRecord,
	) {
		this.#enrichment = { file: path, seq: () => ++this.#eventCounter };
	}

	async poll(): Promise<void> {
		let info: Stats | undefined;
		try {
			info = await stat(this.path);
		} catch {
			return;
		}
		const identity = `${info.dev}:${info.ino}`;
		if (
			this.#identity &&
			(this.#identity !== identity ||
				info.size < this.#offset + this.#fragment.length)
		) {
			this.#offset = 0;
			this.#fragment = new Uint8Array();
		}
		this.#identity = identity;
		if (info.size <= this.#offset + this.#fragment.length) return;
		// Chunked read: stop as soon as one newline exists; the unread suffix of
		// the last chunk is picked up by the next poll, so reads stay bounded.
		let combined = this.#fragment; // never contains 0x0a
		let position = this.#offset + this.#fragment.length;
		let lastNewline = -1;
		while (position < info.size) {
			const end = Math.min(position + READ_CHUNK_BYTES, info.size);
			const chunk = new Uint8Array(
				await Bun.file(this.path).slice(position, end).arrayBuffer(),
			);
			if (!chunk.length) break;
			position += chunk.length;
			const merged = new Uint8Array(combined.length + chunk.length);
			merged.set(combined);
			merged.set(chunk, combined.length);
			combined = merged;
			lastNewline = combined.lastIndexOf(10);
			if (lastNewline >= 0) break;
			if (combined.length > MAX_LINE_BYTES) {
				this.#warn(
					`line without newline exceeds ${MAX_LINE_BYTES} bytes; keeping the last ${MAX_LINE_BYTES} bytes`,
				);
				combined = combined.slice(-MAX_LINE_BYTES);
				this.#offset = position - combined.length;
			}
		}
		if (lastNewline < 0) {
			this.#fragment = combined;
			return;
		}
		let lineStart = 0;
		for (let index = 0; index <= lastNewline; index += 1) {
			if (combined[index] !== 10) continue;
			const line = combined.subarray(lineStart, index);
			lineStart = index + 1;
			if (line.length > MAX_LINE_BYTES) {
				this.#warn(`skipping oversized ${line.length}-byte line`);
				continue;
			}
			const text = decoder.decode(line).trim();
			try {
				const parsed = this.normalize(JSON.parse(text) as PiRecord);
				if (parsed.session) this.callbacks.onSession?.(parsed.session);
				for (const event of parsed.events)
					this.callbacks.onEvent(enrichEvent(event, this.#enrichment));
			} catch {
				// A malformed line must not stall subsequent complete JSONL records.
			}
		}
	}

	#warn(message: string): void {
		console.warn(`pi-jsonl: ${this.path}: ${message}`);
		this.callbacks.onError?.(message);
	}
}
