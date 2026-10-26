import { describe, expect, test } from "bun:test";
import { parseDaemonMessage } from "./protocol.ts";

describe("parseDaemonMessage", () => {
	test("accepts every daemon message shape", () => {
		const valid = [
			{ type: "session_init", events: [] },
			{
				type: "session_init",
				session_id: "s",
				transcript_path: "/tmp/p.jsonl",
				events: [
					{
						timestamp: "1",
						headline: "h",
						details: "d",
						event_type: "tool_call",
						id: "e1",
						parent_id: "p1",
						session_file: "/tmp/session.jsonl",
						diff: "diff --git",
						bash_tail: "bun test",
						signals: ["error"],
						dead_air: false,
					},
				],
			},
			{
				type: "new_event",
				event: {
					timestamp: "1",
					headline: "h",
					details: "d",
					event_type: "user_task",
				},
			},
			{ type: "ambient_insight", insight: "i" },
			{ type: "guardrail", findings: ["f"] },
			{ type: "dead_air_insight", insight: "i", command: "pytest" },
			{
				type: "tutor_answer",
				answer: "a",
				mermaid: "flowchart LR",
				voice: { language: "en", speed: 1, voice: "Aria" },
			},
			{ type: "steering_prompt", prompt: "p" },
			{
				type: "tutor_documents",
				documents: {
					hud_state: { status: "idle", mode: "spotter", message: "" },
					scratchpad_diagram: { diagram: "flowchart TD" },
					socratic_quiz: { question: "", options: [] },
					steering_prompt: { prompt: "" },
					research_scratchpad: { name: "", content: "" },
					tutor_trace: [],
				},
			},
			{ type: "mode_changed", name: "socratic" },
			{
				type: "modes",
				modes: [{ name: "m", title: "t", description: "d" }],
				active: "m",
			},
			{ type: "daemon_error", scope: "provider", message: "down" },
			{ type: "error", message: "frame too large" },
		];
		for (const message of valid)
			expect(parseDaemonMessage(message) as unknown).toBe(message);
	});

	test("rejects malformed values", () => {
		for (const invalid of [
			undefined,
			null,
			"ambient_insight",
			{},
			{ type: 7 },
			{ type: "unknown_kind" },
			{ type: "session_init", events: "no" },
			{ type: "new_event", event: { type: "tool_call" } },
			{ type: "mode_changed" },
			{ type: "modes", modes: [{ name: "m" }], active: "m" },
			{ type: "daemon_error", scope: "elsewhere", message: "x" },
			{
				type: "new_event",
				event: {
					timestamp: "1",
					headline: "h",
					details: "d",
					event_type: "tool_call",
					signals: [7],
				},
			},
			{ type: "tutor_answer", voice: { speed: "fast" } },
			{ type: "daemon_error", scope: "provider" },
			{
				type: "tutor_documents",
				documents: {
					hud_state: { status: "invalid", mode: "", message: "" },
				},
			},
		])
			expect(parseDaemonMessage(invalid)).toBeUndefined();
	});
});
