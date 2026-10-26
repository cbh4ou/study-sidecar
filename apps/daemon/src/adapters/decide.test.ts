import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../ingest/events.ts";
import type { TutorMode } from "../modes/modes.ts";
import {
	certain,
	DECIDE_OPTIONS,
	type DecideOptions,
	type DecidePort,
	type DecideTask,
	type Decision,
} from "../ports/decide.ts";
import { DEFAULT_SETTINGS, type StoredSettings } from "../settings.ts";
import { ComposedDecide } from "./decide-compose.ts";
import { FakeDecide } from "./decide-fake.ts";
import { JevDecide } from "./decide-jev.ts";
import { LlmDecide } from "./decide-llm.ts";
import { RulesDecide } from "./decide-rules.ts";
import { FakeLlm, registerFakeJsonResponder } from "./llm-fake.ts";

const SECRET = "api_key=SUPERSECRETVALUE123";

function settingsWith(decide: Partial<StoredSettings["decide"]> = {}): {
	value: StoredSettings;
} {
	return {
		value: {
			...structuredClone(DEFAULT_SETTINGS),
			decide: { ...DEFAULT_SETTINGS.decide, ...decide },
		},
	};
}

const mode = {
	name: "socratic",
	wake_triggers: { on_tools: ["edit", "write", "bash"], highlight_regex: "" },
} as unknown as TutorMode;

const event = (patch: Partial<SessionEvent>): SessionEvent => ({
	timestamp: "2026-10-20T14:02:00Z",
	event_type: "tool_call",
	headline: "Execute: Edit",
	details: "",
	...patch,
});

class Spy implements DecidePort {
	calls = 0;
	constructor(
		private readonly result: (
			options: readonly string[],
		) => Decision<string> | Error,
	) {}
	async decide<T extends string>(
		_task: DecideTask,
		_input: string,
		options: readonly T[],
		_opts?: DecideOptions,
	): Promise<Decision<T>> {
		this.calls++;
		const result = this.result(options);
		if (result instanceof Error) throw result;
		return result as Decision<T>;
	}
}

describe("RulesDecide", () => {
	const rules = new RulesDecide();
	const intent = (text: string) =>
		rules.decide("intent", text, DECIDE_OPTIONS.intent);

	test("intent keywords (T9 rules)", async () => {
		expect((await intent("stop")).choice).toBe("cancel");
		expect((await intent("Never mind.")).choice).toBe("cancel");
		expect((await intent("send that back to Claude")).choice).toBe(
			"bridge_back",
		);
		expect(
			(await intent("what did we change across all sessions")).choice,
		).toBe("question_all_sessions");
		expect((await intent("blue widgets")).choice).toBe("question");
		const decision = await intent("stop");
		expect(decision.adapter).toBe("rules");
		expect(decision.confidence).toBe(1);
	});

	test("lane, nudge, explain_back, concept_route, anchor_pick", async () => {
		expect(
			(
				await rules.decide(
					"lane",
					"look up the latest pika docs",
					DECIDE_OPTIONS.lane,
				)
			).choice,
		).toBe("needs_web");
		expect(
			(await rules.decide("lane", "why ack", DECIDE_OPTIONS.lane)).choice,
		).toBe("fast_and_deep");
		expect(
			(await rules.decide("nudge_gate", "x", DECIDE_OPTIONS.nudge_gate)).choice,
		).toBe("hold");
		expect(
			(await rules.decide("explain_back", "x", DECIDE_OPTIONS.explain_back))
				.choice,
		).toBe("partial");
		expect(
			(await rules.decide("concept_route", "x", ["p1", "p2", "new_concept"]))
				.choice,
		).toBe("new_concept");
		expect(
			(await rules.decide("concept_route", "x", ["p1", "p2"])).choice,
		).toBe("p1");
		expect(
			(await rules.decide("anchor_pick", "x", ["h1", "h2", "h3"])).choice,
		).toBe("h3");
	});

	test("fsrs_rating maps explain-back verdicts (T8)", async () => {
		const rate = async (text: string) =>
			(await rules.decide("fsrs_rating", text, DECIDE_OPTIONS.fsrs_rating))
				.choice;
		expect(await rate("correct")).toBe("good");
		expect(await rate("partial")).toBe("hard");
		expect(await rate("misconception")).toBe("again");
		expect(await rate("off_topic")).toBe("again");
		expect(await rate("")).toBe("good");
	});

	test("turn_relevance from the event", async () => {
		const rel = async (patch?: Partial<SessionEvent>) =>
			(
				await rules.decide(
					"turn_relevance",
					"",
					DECIDE_OPTIONS.turn_relevance,
					{
						context: patch ? { event: event(patch) } : undefined,
					},
				)
			).choice;
		expect(await rel({ event_type: "tool_result", tool_name: "Read" })).toBe(
			"receipt_only",
		);
		expect(await rel({ event_type: "tool_result", tool_name: "Grep" })).toBe(
			"receipt_only",
		);
		expect(await rel({ event_type: "tool_call", tool_name: "Edit" })).toBe(
			"include",
		);
		expect(
			await rel({
				event_type: "tool_result",
				tool_name: "Read",
				is_error: true,
			}),
		).toBe("include");
		expect(await rel({ event_type: "agent_thought" })).toBe("drop");
		expect(await rel()).toBe("include");
	});

	test("delta_class wraps classifyDelta", async () => {
		const delta = async (context?: Record<string, unknown>) =>
			(
				await rules.decide("delta_class", "", DECIDE_OPTIONS.delta_class, {
					context,
				})
			).choice;
		expect(await delta()).toBe("SILENT");
		expect(
			await delta({
				event: event({ event_type: "tool_result", is_error: true }),
				mode,
				findings: [],
			}),
		).toBe("PROACTIVE_COACH");
		expect(
			await delta({
				event: event({ tool_name: "edit", details: "small" }),
				mode,
				findings: [],
			}),
		).toBe("AMBIENT_PILL");
	});

	test("always returns a member of options", async () => {
		const decision = await rules.decide("intent", "stop", [
			"question",
			"command",
		]);
		expect(decision.choice).toBe("question");
	});
});

describe("FakeDecide", () => {
	test("table rows win, then rules (T9 fake)", async () => {
		const fake = new FakeDecide();
		const stop = await fake.decide("intent", "stop", DECIDE_OPTIONS.intent);
		expect(stop.choice).toBe("cancel");
		expect(stop.adapter).toBe("fake");
		expect(
			(
				await fake.decide(
					"intent",
					"send that back to Claude",
					DECIDE_OPTIONS.intent,
				)
			).choice,
		).toBe("bridge_back");
		expect(
			(
				await fake.decide(
					"nudge_gate",
					"saw an ack timeout",
					DECIDE_OPTIONS.nudge_gate,
				)
			).choice,
		).toBe("nudge");
		expect(
			(await fake.decide("nudge_gate", "nothing", DECIDE_OPTIONS.nudge_gate))
				.choice,
		).toBe("hold");
	});

	test("custom table", async () => {
		const fake = new FakeDecide({
			lane: [{ match: "zz", choice: "fast_only" }],
		});
		expect(
			(await fake.decide("lane", "zz top", DECIDE_OPTIONS.lane)).choice,
		).toBe("fast_only");
	});
});

describe("LlmDecide", () => {
	test("parses choice and confidence via the fast lane", async () => {
		const llm = new FakeLlm({ delayMs: 0 });
		const off = registerFakeJsonResponder(
			(request) => request.system.includes("closed-set"),
			() => ({ choice: "think_aloud", confidence: 0.9 }),
		);
		try {
			const decision = await new LlmDecide(llm).decide(
				"intent",
				"hmm so the ack",
				DECIDE_OPTIONS.intent,
			);
			expect(decision.choice).toBe("think_aloud");
			expect(decision.confidence).toBe(0.9);
			expect(decision.adapter).toBe("llm");
			expect(llm.requests[0]?.lane).toBe("fast");
			expect(llm.requests[0]?.json).toBe(true);
		} finally {
			off();
		}
	});

	test("invalid choice throws", async () => {
		const off = registerFakeJsonResponder(
			() => true,
			() => ({ choice: "dance", confidence: 0.9 }),
		);
		try {
			await expect(
				new LlmDecide(new FakeLlm({ delayMs: 0 })).decide(
					"intent",
					"x",
					DECIDE_OPTIONS.intent,
				),
			).rejects.toThrow("not an option");
		} finally {
			off();
		}
	});
});

describe("JevDecide", () => {
	test("posts redacted input with bearer key (T2)", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const jev = new JevDecide({
			settings: settingsWith({ jevApiKey: "jev-key-1" }),
			fetchImpl: async (url, init) => {
				requests.push({ url: String(url), init });
				return Response.json({
					choice: "question",
					probs: { question: 0.92 },
					confidence: 0.92,
				});
			},
		});
		const decision = await jev.decide(
			"intent",
			`why does ${SECRET} leak`,
			DECIDE_OPTIONS.intent,
		);
		expect(decision.adapter).toBe("jev");
		expect(decision.choice).toBe("question");
		const [request] = requests;
		expect(request?.url).toBe("https://api.typesafe.ai/v1/decide");
		const headers = request?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer jev-key-1");
		const body = JSON.parse(String(request?.init?.body));
		expect(body.task).toBe("intent");
		expect(body.options).toEqual([...DECIDE_OPTIONS.intent]);
		expect(String(request?.init?.body)).not.toContain("SUPERSECRETVALUE123");
		expect(body.input).toContain("api_key=***");
	});

	test("custom url, bad payload and local_only refusal", async () => {
		let url = "";
		const jev = new JevDecide({
			settings: settingsWith({ jevApiKey: "k", jevUrl: "https://jev.test/d" }),
			fetchImpl: async (input) => {
				url = String(input);
				return Response.json({ nope: true });
			},
		});
		await expect(
			jev.decide("intent", "x", DECIDE_OPTIONS.intent),
		).rejects.toThrow();
		expect(url).toBe("https://jev.test/d");
		url = "";
		await expect(
			jev.decide("intent", "x", DECIDE_OPTIONS.intent, { localOnly: true }),
		).rejects.toThrow("local_only");
		expect(url).toBe("");
	});
});

describe("ComposedDecide (T4)", () => {
	const jevAt = (confidence: number) =>
		new Spy((options) =>
			certain(options[1] ?? "", options, "jev", 0, confidence),
		);
	const llmPick = () =>
		new Spy((options) => certain(options[2] ?? "", options, "llm", 0, 0.8));
	const rulesPick = () =>
		new Spy((options) => certain(options[0] ?? "", options, "rules"));
	const compose = (
		parts: { jev: Spy; llm: Spy; rules: Spy },
		decide: Partial<StoredSettings["decide"]>,
		isCloud = true,
	) =>
		new ComposedDecide({
			settings: settingsWith(decide),
			...parts,
			llmPort: { isCloud },
		});

	test("confident Jev wins", async () => {
		const parts = { jev: jevAt(0.95), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(parts, { jevApiKey: "k" }).decide(
			"intent",
			"x",
			DECIDE_OPTIONS.intent,
		);
		expect(decision.adapter).toBe("jev");
		expect(parts.llm.calls).toBe(0);
		expect(decision.ms).toBeGreaterThanOrEqual(0);
	});

	test("low-confidence Jev escalates to the LLM", async () => {
		const parts = { jev: jevAt(0.4), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(parts, { jevApiKey: "k" }).decide(
			"intent",
			"x",
			DECIDE_OPTIONS.intent,
		);
		expect(parts.jev.calls).toBe(1);
		expect(parts.llm.calls).toBe(1);
		expect(decision.adapter).toBe("llm");
	});

	test("threshold comes from settings", async () => {
		const parts = { jev: jevAt(0.4), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(parts, {
			jevApiKey: "k",
			threshold: 0.3,
		}).decide("intent", "x", DECIDE_OPTIONS.intent);
		expect(decision.adapter).toBe("jev");
		expect(parts.llm.calls).toBe(0);
	});

	test("Jev error falls through to rules", async () => {
		const parts = {
			jev: new Spy(() => new Error("boom")),
			llm: llmPick(),
			rules: rulesPick(),
		};
		const decision = await compose(parts, { jevApiKey: "k" }).decide(
			"intent",
			"x",
			DECIDE_OPTIONS.intent,
		);
		expect(decision.adapter).toBe("rules");
		expect(parts.rules.calls).toBe(1);
	});

	test("LLM error after escalation falls to rules", async () => {
		const parts = {
			jev: jevAt(0.2),
			llm: new Spy(() => new Error("bad json")),
			rules: rulesPick(),
		};
		const decision = await compose(parts, { jevApiKey: "k" }).decide(
			"intent",
			"x",
			DECIDE_OPTIONS.intent,
		);
		expect(decision.adapter).toBe("rules");
	});

	test('adapter "rules" never calls Jev or the LLM', async () => {
		const parts = { jev: jevAt(0.99), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(parts, {
			adapter: "rules",
			jevApiKey: "k",
		}).decide("explain_back", "x", DECIDE_OPTIONS.explain_back);
		expect(decision.adapter).toBe("rules");
		expect(parts.jev.calls + parts.llm.calls).toBe(0);
	});

	test("no key skips Jev", async () => {
		const parts = { jev: jevAt(0.99), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(parts, {}).decide(
			"intent",
			"x",
			DECIDE_OPTIONS.intent,
		);
		expect(parts.jev.calls).toBe(0);
		expect(decision.adapter).toBe("rules");
	});

	test("localOnly never calls Jev and skips a cloud LLM", async () => {
		const parts = { jev: jevAt(0.2), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(
			parts,
			{ adapter: "jev", jevApiKey: "k" },
			true,
		).decide("intent", "x", DECIDE_OPTIONS.intent, { localOnly: true });
		expect(parts.jev.calls).toBe(0);
		expect(parts.llm.calls).toBe(0);
		expect(decision.adapter).toBe("rules");
	});

	test("localOnly may use a local LLM", async () => {
		const parts = { jev: jevAt(0.2), llm: llmPick(), rules: rulesPick() };
		const decision = await compose(
			parts,
			{ adapter: "llm", jevApiKey: "k" },
			false,
		).decide("intent", "x", DECIDE_OPTIONS.intent, { localOnly: true });
		expect(parts.jev.calls).toBe(0);
		expect(decision.adapter).toBe("llm");
	});

	test("auto without Jev uses the LLM for explain_back only", async () => {
		const parts = { jev: jevAt(0.99), llm: llmPick(), rules: rulesPick() };
		const composed = compose(parts, {});
		expect(
			(await composed.decide("explain_back", "x", DECIDE_OPTIONS.explain_back))
				.adapter,
		).toBe("llm");
		expect(
			(await composed.decide("intent", "x", DECIDE_OPTIONS.intent)).adapter,
		).toBe("rules");
	});
});
