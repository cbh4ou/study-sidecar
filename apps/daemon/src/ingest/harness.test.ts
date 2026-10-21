import { describe, expect, test } from "bun:test";
import { normalizeClaudeRecord, normalizeCodexRecord } from "./harness.ts";

describe("Codex and Claude transcript normalization", () => {
	test("normalizes Codex session, text, and command events", () => {
		expect(
			normalizeCodexRecord({
				type: "session_meta",
				payload: { session_id: "c1", cwd: "/work/repo" },
			}).session,
		).toMatchObject({ id: "c1", cwd: "/work/repo" });
		expect(
			normalizeCodexRecord({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ text: "fix it" }],
				},
			}).events[0],
		).toMatchObject({ event_type: "user_task", headline: "User: fix it" });
		expect(
			normalizeCodexRecord({
				type: "response_item",
				payload: {
					type: "custom_tool_call",
					name: "exec_command",
					input: { command: "bun test" },
				},
			}).events[0],
		).toMatchObject({ tool_name: "Bash", headline: "Run: `bun test`" });
	});

	test("normalizes Claude user, assistant tool, and tool result events", () => {
		expect(
			normalizeClaudeRecord({ type: "user", message: { content: "build it" } })
				.events[0],
		).toMatchObject({ event_type: "user_task" });
		expect(
			normalizeClaudeRecord({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "1",
							name: "Write",
							input: { path: "x.ts" },
						},
					],
				},
			}).events[0],
		).toMatchObject({ event_type: "tool_call", tool_name: "Write" });
		expect(
			normalizeClaudeRecord({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "1",
							is_error: true,
							content: "failed",
						},
					],
				},
			}).events[0],
		).toMatchObject({ event_type: "tool_result", is_error: true });
	});
});
