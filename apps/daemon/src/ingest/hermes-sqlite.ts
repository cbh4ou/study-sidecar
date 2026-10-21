import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { sieveToolResult } from "../sieve/tier0.ts";
import type { SessionEvent, SessionInfo, TailerCallbacks } from "./events.ts";

type SessionRow = {
	id: string;
	cwd: string | null;
	title: string | null;
	timestamp: number;
};
type MessageRow = {
	id: number;
	role: string;
	content: string | null;
	tool_calls: string | null;
	tool_name: string | null;
	timestamp: number;
	reasoning: string | null;
};

function openReadOnly(path: string): Database {
	const database = new Database(path, { readonly: true });
	database.exec("PRAGMA query_only = ON");
	database.exec("PRAGMA busy_timeout = 0");
	return database;
}

export function latestHermesSession(path: string): SessionRow | undefined {
	let database: Database | undefined;
	try {
		database = openReadOnly(path);
		const columns = new Set(
			(
				database.query("PRAGMA table_info(sessions)").all() as Array<{
					name: string;
				}>
			).map((row) => row.name),
		);
		const cwd = columns.has("cwd") ? "s.cwd" : "NULL";
		const title = columns.has("title") ? "s.title" : "NULL";
		return database
			.query(
				`SELECT s.id, ${cwd} AS cwd, ${title} AS title, m.timestamp
				 FROM messages m JOIN sessions s ON s.id = m.session_id
				 ORDER BY m.id DESC LIMIT 1`,
			)
			.get() as SessionRow | undefined;
	} catch {
		return undefined;
	} finally {
		database?.close();
	}
}

function normalize(row: MessageRow): SessionEvent[] {
	const timestamp = new Date(row.timestamp * 1000).toISOString();
	const content = row.content ?? "";
	const line = content.trim().split(/\r?\n/, 1)[0]?.slice(0, 100) ?? "";
	const events: SessionEvent[] = [];
	if (row.role === "user" && content.trim())
		events.push({
			timestamp,
			event_type: "user_task",
			headline: `User: ${line}`,
			details: content,
		});
	if (row.role === "assistant") {
		if (row.reasoning?.trim())
			events.push({
				timestamp,
				event_type: "agent_thought",
				headline: "Hermes: reasoning",
				details: row.reasoning,
			});
		if (content.trim())
			events.push({
				timestamp,
				event_type: "agent_message",
				headline: `Hermes: ${line}`,
				details: content,
			});
		if (row.tool_calls) {
			try {
				const calls: unknown = JSON.parse(row.tool_calls);
				if (Array.isArray(calls))
					for (const call of calls) {
						if (!call || typeof call !== "object") continue;
						const value = call as {
							function?: { name?: string; arguments?: string };
							id?: string;
						};
						const name = value.function?.name ?? "tool";
						const args = value.function?.arguments ?? "";
						events.push({
							timestamp,
							event_type: "tool_call",
							headline: `Execute: ${name}`,
							details: args,
							tool_name: name,
							metadata: { tool_call_id: value.id },
						});
					}
			} catch {}
		}
	}
	if (row.role === "tool") {
		const name = row.tool_name ?? "tool";
		const details = sieveToolResult(name, content);
		events.push({
			timestamp,
			event_type: "tool_result",
			headline: `${name}: ${details.split(/\r?\n/, 1)[0]?.slice(0, 100) ?? ""}`,
			details,
			tool_name: name,
		});
	}
	return events;
}

export class HermesTailer {
	#database: Database;
	#lastId = 0;
	#polling = false;

	constructor(
		path: string,
		private readonly session: SessionRow,
		private readonly callbacks: TailerCallbacks,
	) {
		this.#database = openReadOnly(path);
		const oldest = this.#database
			.query(
				"SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET 199",
			)
			.get(session.id) as { id: number } | undefined;
		this.#lastId = oldest ? oldest.id - 1 : 0;
		const info: SessionInfo = {
			id: session.id,
			cwd: session.cwd ?? undefined,
			project_name: session.cwd ? basename(session.cwd) : undefined,
			current_goal: session.title ?? undefined,
		};
		callbacks.onSession?.(info);
	}

	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const rows = this.#database
				.query(
					"SELECT id, role, content, tool_calls, tool_name, timestamp, reasoning FROM messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT 200",
				)
				.all(this.session.id, this.#lastId) as MessageRow[];
			for (const row of rows) {
				this.#lastId = row.id;
				for (const event of normalize(row)) this.callbacks.onEvent(event);
			}
		} catch (error) {
			this.callbacks.onError?.(`Hermes read failed: ${String(error)}`);
		} finally {
			this.#polling = false;
		}
	}

	close(): void {
		this.#database.close();
	}
}
