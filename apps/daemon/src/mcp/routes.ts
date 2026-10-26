import { z } from "zod";
import {
	type DaemonContext,
	type Feature,
	json,
	readBody,
} from "../feature.ts";
import type { SourceRef } from "../protocol.ts";

const FIELD_CAP = 2_000;
const FILES_CAP = 20;

export const AskBody = z.object({
	question: z.string().trim().min(1).max(4_000),
	topic_hint: z.string().max(200).optional(),
	context: z
		.object({
			files: z.array(z.string().max(1_000)).max(200).optional(),
			diff_summary: z.string().max(20_000).optional(),
			what_agent_did: z.string().max(20_000).optional(),
		})
		.optional(),
});

export const NoteBody = z.object({
	concept: z.string().trim().min(1).max(200),
	source_ref: z.string().max(1_000).optional(),
	why: z.string().max(2_000).optional(),
});

const cap = (text: string, limit = FIELD_CAP) =>
	text.length > limit ? `${text.slice(0, limit)} (truncated)` : text;

/** One question text: the agent's question plus labeled, capped context. */
export function composeQuestion(input: z.infer<typeof AskBody>): string {
	const parts = [cap(input.question.trim())];
	if (input.topic_hint?.trim())
		parts.push(`Topic: ${cap(input.topic_hint, 200)}`);
	const files = input.context?.files?.filter((file) => file.trim()) ?? [];
	if (files.length) {
		const shown = files.slice(0, FILES_CAP).join(", ");
		const more =
			files.length > FILES_CAP ? ` (+${files.length - FILES_CAP} more)` : "";
		parts.push(`Files: ${cap(shown)}${more}`);
	}
	if (input.context?.diff_summary?.trim())
		parts.push(`Diff summary: ${cap(input.context.diff_summary.trim())}`);
	if (input.context?.what_agent_did?.trim())
		parts.push(
			`What the agent did: ${cap(input.context.what_agent_did.trim())}`,
		);
	return parts.join("\n\n");
}

/** Parse a `source_ref` string into a SourceRef when it is recognisable. */
export function parseSourceRef(
	value: string | undefined,
	bound?: { harness?: string; sessionId?: string; path: string },
): SourceRef | undefined {
	const text = value?.trim();
	if (!text) {
		return bound?.sessionId
			? {
					kind: "session",
					harness: bound.harness ?? "unknown",
					sessionId: bound.sessionId,
					file: bound.path,
				}
			: undefined;
	}
	if (/^https?:\/\//i.test(text)) return { kind: "web", url: text };
	const match = text.match(/^(.*?):(\d+)(?:-(\d+))?$/);
	if (match?.[1]) {
		const start = Number(match[2]);
		const end = Number(match[3] ?? match[2]);
		return { kind: "file", path: match[1], lines: [start, end] };
	}
	return { kind: "file", path: text };
}

type NoteRecorder = {
	recordNote?(note: { concept: string; why?: string }): void;
};

/** `/api/mcp/ask` and `/api/mcp/note`: the daemon side of the MCP server. */
export function createMcpRoutesFeature(
	context: DaemonContext,
	ticket: () => string = () =>
		`t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
): Feature {
	return {
		name: "mcp",
		async route(request, url, cors) {
			if (url.pathname !== "/api/mcp/ask" && url.pathname !== "/api/mcp/note")
				return undefined;
			if (request.method !== "POST")
				return json({ error: "method not allowed" }, cors, 405);
			const body = await readBody(request);
			if (url.pathname === "/api/mcp/ask") {
				const parsed = AskBody.safeParse(body);
				if (!parsed.success)
					return json({ error: "question is required" }, cors, 400);
				const id = ticket();
				// Fire and forget: the answer goes to the pill and panel only.
				void context
					.dispatch({
						type: "question",
						text: composeQuestion(parsed.data),
						source: "mcp",
					})
					.catch((error: unknown) =>
						context.broadcast({
							type: "daemon_error",
							scope: "provider",
							message: `agent question failed: ${error instanceof Error ? error.message : String(error)}`,
						}),
					);
				return json({ status: "sent", ticket: id }, cors);
			}
			const parsed = NoteBody.safeParse(body);
			if (!parsed.success)
				return json({ error: "concept is required" }, cors, 400);
			const sessions = context.services.sessions;
			const source = parseSourceRef(parsed.data.source_ref, sessions?.bound());
			await context.services.learn?.noteConcept({
				concept: parsed.data.concept,
				...(parsed.data.why ? { why: parsed.data.why } : {}),
				...(source ? { source } : {}),
			});
			(sessions as NoteRecorder | undefined)?.recordNote?.({
				concept: parsed.data.concept,
				...(parsed.data.why ? { why: parsed.data.why } : {}),
			});
			context.broadcast({ type: "sessions_changed" });
			return json({ status: "noted" }, cors);
		},
	};
}
