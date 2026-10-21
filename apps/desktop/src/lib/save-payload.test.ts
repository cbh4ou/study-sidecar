import { describe, expect, test } from "bun:test";
import { buildSavePayload } from "./save-payload";

describe("save payload builder", () => {
	test("uses the last question as title, truncated to 80 characters", () => {
		const payload = buildSavePayload(["q".repeat(100)], ["answer"]);
		expect(payload?.title).toBe("q".repeat(80));
		expect(payload?.body).toBe("answer");
	});

	test("caps the body at 20000 characters", () => {
		const payload = buildSavePayload(["question"], ["a".repeat(25_000)]);
		expect(payload?.body.length).toBe(20_000);
	});

	test("falls back to the answer for the title without a question", () => {
		expect(buildSavePayload([], ["first line of the answer"])?.title).toBe(
			"first line of the answer",
		);
	});

	test("includes linked Mermaid, tool use, and session context", () => {
		const event = Object.assign(
			{
				timestamp: "1",
				headline: "Edit file",
				details: "",
				event_type: "tool_call" as const,
			},
			{
				metadata: { tool_call_id: "call_123" },
				session_file: "/tmp/session.jsonl",
			},
		);
		expect(
			buildSavePayload(
				["diagram"],
				["Here is the flow.\n```mermaid\nflowchart LR\nA --> B\n```"],
				[event],
			),
		).toMatchObject({
			mermaid: "flowchart LR\nA --> B",
			tool_use_id: "call_123",
			session_file: "/tmp/session.jsonl",
		});
	});

	test("returns null without an answer to save", () => {
		expect(buildSavePayload(["question"], [])).toBeNull();
		expect(buildSavePayload(["question"], ["   "])).toBeNull();
	});
});
