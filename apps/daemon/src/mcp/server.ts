import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDaemonClient, type DaemonClient } from "./client.ts";

/** Input schemas exactly per spec Section 15. */
export const tutorAskShape = {
	question: z.string(),
	topic_hint: z.string().optional(),
	context: z
		.object({
			files: z.array(z.string()).optional(),
			diff_summary: z.string().optional(),
			what_agent_did: z.string().optional(),
		})
		.optional(),
};

export const tutorNoteShape = {
	concept: z.string(),
	source_ref: z.string().optional(),
	why: z.string().optional(),
};

type AskArgs = z.infer<z.ZodObject<typeof tutorAskShape>>;
type NoteArgs = z.infer<z.ZodObject<typeof tutorNoteShape>>;
type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

const text = (value: unknown, isError = false): TextResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	...(isError ? { isError: true } : {}),
});

/**
 * tutor_ask: hands the question to the learner's tutor. The result is only
 * `{status, ticket}`; whatever the daemon returns beyond that is dropped, so
 * the answer can never leak back into the agent's context.
 */
export async function tutorAsk(
	client: DaemonClient,
	args: AskArgs,
): Promise<TextResult> {
	try {
		const response = (await client.post("/api/mcp/ask", args)) as {
			ticket?: unknown;
		};
		const ticket = typeof response?.ticket === "string" ? response.ticket : "";
		if (!ticket) return text({ status: "error", error: "no ticket" }, true);
		return text({ status: "sent", ticket });
	} catch (error) {
		return text(
			{
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			},
			true,
		);
	}
}

/** tutor_note: flags a concept for the learner's recap and card candidates. */
export async function tutorNote(
	client: DaemonClient,
	args: NoteArgs,
): Promise<TextResult> {
	try {
		await client.post("/api/mcp/note", args);
		return text({ status: "noted" });
	} catch (error) {
		return text(
			{
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			},
			true,
		);
	}
}

export function tutorPrompt(question: string) {
	return {
		messages: [
			{
				role: "user" as const,
				content: {
					type: "text" as const,
					text: [
						"Call the `tutor_ask` tool from the study-sidecar MCP server with this question for the learner's tutor:",
						"",
						question,
						"",
						"Include `context` (files you touched, a short diff summary, what you just did) when it helps. The answer goes to the learner's study sidecar, not to you: after the tool returns `sent`, continue your task.",
					].join("\n"),
				},
			},
		],
	};
}

export function createMcpServer(
	client: DaemonClient = createDaemonClient(),
): McpServer {
	const server = new McpServer({ name: "study-sidecar", version: "0.1.0" });
	server.registerTool(
		"tutor_ask",
		{
			description:
				"Send a question to the learner's study tutor (voice pill and panel). Returns only a ticket; the answer is shown to the learner, never to you.",
			inputSchema: tutorAskShape,
		},
		(args) => tutorAsk(client, args),
	);
	server.registerTool(
		"tutor_note",
		{
			description:
				"Flag a concept the learner should review later (session recap and review card candidates).",
			inputSchema: tutorNoteShape,
		},
		(args) => tutorNote(client, args),
	);
	server.registerPrompt(
		"tutor",
		{
			description: "Ask the learner's study tutor a question via tutor_ask.",
			argsSchema: { question: z.string() },
		},
		({ question }) => tutorPrompt(question),
	);
	return server;
}

/** Stdio entry point (`bun run sidecar mcp`). */
export async function main(): Promise<void> {
	const server = createMcpServer();
	await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
