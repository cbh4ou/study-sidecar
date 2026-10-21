import { describe, expect, test } from "bun:test";
import {
	initialDesktopState,
	nextReconnectDelay,
	reduceDaemonMessage,
} from "./store";

describe("desktop message store", () => {
	test("bounds session events and retains coach cards", () => {
		const state = reduceDaemonMessage(initialDesktopState, {
			type: "session_init",
			events: [
				{
					timestamp: "1",
					headline: "Start",
					details: "",
					event_type: "system",
				},
			],
		});
		const next = reduceDaemonMessage(state, {
			type: "ambient_insight",
			insight: "Read the diff.",
		});
		expect(next.events).toHaveLength(1);
		expect(next.insights).toEqual([
			{ kind: "ambient", text: "Read the diff." },
		]);
	});

	test("retains bounded daemon errors until the next session starts", () => {
		const errored = reduceDaemonMessage(initialDesktopState, {
			type: "daemon_error",
			scope: "provider",
			message: "Tutor unavailable",
		});
		const framed = reduceDaemonMessage(errored, {
			type: "error",
			message: "Frame rejected",
		});
		expect(framed.errors).toEqual([
			{ scope: "provider", message: "Tutor unavailable" },
			{ scope: "daemon", message: "Frame rejected" },
		]);
		expect(
			reduceDaemonMessage(framed, { type: "session_init", events: [] }).errors,
		).toEqual([]);
	});

	test("session change wipes conversation, reconnect replay keeps it", () => {
		const base = reduceDaemonMessage(initialDesktopState, {
			type: "session_init",
			session_id: "a",
			transcript_path: "/a.jsonl",
			events: [],
		});
		const updates = [
			{ type: "tutor_answer", answer: "why" },
			{ type: "ambient_insight", insight: "note" },
			{ type: "steering_prompt", prompt: "go" },
		] as const;
		const busy = updates.reduce(reduceDaemonMessage, base);
		const reconnect = reduceDaemonMessage(busy, {
			type: "session_init",
			session_id: "a",
			transcript_path: "/a.jsonl",
			events: [],
		});
		expect(reconnect.answers).toEqual(["why"]);
		expect(reconnect.insights).toHaveLength(1);
		expect(reconnect.prompts).toEqual(["go"]);
		const rotated = reduceDaemonMessage(busy, {
			type: "session_init",
			session_id: "b",
			transcript_path: "/b.jsonl",
			events: [],
		});
		expect(rotated.answers).toEqual([]);
		expect(rotated.insights).toEqual([]);
		expect(rotated.prompts).toEqual([]);
		expect(rotated.questions).toEqual([]);
		expect(rotated.pendingQuestions).toEqual([]);
	});

	test("hydrates the durable Tutor documents", () => {
		const documents = {
			hud_state: { status: "idle" as const, mode: "spotter", message: "" },
			scratchpad_diagram: { diagram: "flowchart TD\nA --> B" },
			socratic_quiz: { question: "", options: [] },
			steering_prompt: { prompt: "Inspect the diff." },
			research_scratchpad: { name: "notes", content: "detail" },
			tutor_trace: [
				{
					label: "Searched OKF memory",
					detail: "durability",
					status: "ok" as const,
				},
			],
		};
		const state = reduceDaemonMessage(initialDesktopState, {
			type: "tutor_documents",
			documents,
		});
		expect(state.documents).toEqual(documents);
	});

	test("caps reconnect delay at four seconds", () => {
		expect([0, 1, 2, 3, 4].map(nextReconnectDelay)).toEqual([
			500, 1_000, 2_000, 4_000, 4_000,
		]);
	});
});
