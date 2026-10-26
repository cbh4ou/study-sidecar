import { describe, expect, test } from "bun:test";
import { ActivityRegistry } from "../activity.ts";
import type { DaemonContext } from "../feature.ts";
import { FakeClock } from "../ports/clock.ts";
import { certain, type DecidePort } from "../ports/decide.ts";
import type { LlmPort, LlmRequest } from "../ports/llm.ts";
import type { DaemonMessage, TurnTelemetry } from "../protocol.ts";
import type { LearnService, Services } from "../services.ts";
import { type DeepLane, type DeepRunInput, FakeDeepLane } from "./deep.ts";
import { CODE_REPLACEMENT, runFastLane, takeSentences } from "./fast.ts";
import { createLanesFeature } from "./feature.ts";
import { ruleIntent, ruleLane } from "./intent-rules.ts";

/* ---- stubs ---- */

function fakeLlm(
	chunks: string[] | ((request: LlmRequest) => string[]),
	opts: { hangUntilAbort?: boolean } = {},
): LlmPort & { requests: LlmRequest[] } {
	const requests: LlmRequest[] = [];
	return {
		isCloud: false,
		requests,
		async *stream(request) {
			requests.push(request);
			const list = typeof chunks === "function" ? chunks(request) : chunks;
			for (const chunk of list) {
				if (request.signal?.aborted) return;
				await Bun.sleep(0);
				yield chunk;
			}
			if (opts.hangUntilAbort)
				await new Promise<void>((resolve) =>
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					}),
				);
		},
		async complete(request) {
			requests.push(request);
			return "Add a retry with backoff around the ack wait.";
		},
	};
}

function rulesDecide(
	lane?: "fast_only" | "fast_and_deep" | "needs_web",
): DecidePort {
	return {
		async decide(task, input, options) {
			const choice =
				task === "intent"
					? (ruleIntent(input) ?? "question")
					: (lane ?? ruleLane(input));
			return certain(choice as (typeof options)[number], options, "rules");
		},
	};
}

class StubDeep implements DeepLane {
	runs: DeepRunInput[] = [];
	aborted = false;
	constructor(private readonly hang = false) {}
	async run(input: DeepRunInput) {
		this.runs.push(input);
		if (this.hang)
			await new Promise<void>((_, reject) =>
				input.signal.addEventListener("abort", () => {
					this.aborted = true;
					reject(new Error("aborted"));
				}),
			);
		return { answer: "Deep answer about acks." };
	}
}

function stubLearn(): LearnService & {
	appended: Array<{
		lessonId: string;
		role: string;
		kind: string;
		text: string;
	}>;
	cards: number;
} {
	const appended: Array<{
		lessonId: string;
		role: string;
		kind: string;
		text: string;
	}> = [];
	const service = {
		appended,
		cards: 0,
		activeLessonId: () => "L1",
		setActiveLesson: () => undefined,
		lesson: async () => undefined,
		appendMessage: async (
			lessonId: string,
			message: { role: string; kind: string; text: string },
		) => {
			appended.push({ lessonId, ...message });
		},
		dueCards: async () => [],
		createCard: async () => {
			service.cards++;
			return {
				id: "c1",
				propositionId: "p",
				question: "q",
				source: { kind: "file", path: "x" },
				createdAt: "",
			} as const;
		},
		grade: async () => undefined,
		answer: async () => undefined,
		noteConcept: async () => undefined,
	};
	return service as unknown as LearnService & typeof service;
}

type Harness = {
	messages: DaemonMessage[];
	feature: ReturnType<typeof createLanesFeature>;
	services: Services;
	telemetry: Array<{ turnId: string; telemetry: TurnTelemetry }>;
	noted: Array<{ id: string; text: string }>;
	settled(): Promise<void>;
};

function harness(opts: {
	llm: LlmPort;
	decide?: DecidePort;
	deep?: DeepLane;
	learn?: LearnService;
	steering?: string;
	fake?: boolean;
}): Harness {
	const messages: DaemonMessage[] = [];
	const telemetry: Harness["telemetry"] = [];
	const noted: Harness["noted"] = [];
	const services: Services = {
		...(opts.learn ? { learn: opts.learn } : {}),
		telemetry: {
			record: (turnId, value) => telemetry.push({ turnId, telemetry: value }),
			recent: () => [],
		},
		graph: {
			snapshot: async () => ({
				nodes: [],
				chains: [],
				implications: [],
				groups: [],
			}),
			search: async () => [],
			recent: async () => [],
			get: async () => undefined,
			noteProse: (_source, list) => noted.push(...list),
		},
	};
	const broadcast = (message: DaemonMessage) => messages.push(message);
	let turn = 0;
	const context = {
		home: "/tmp",
		root: "/tmp",
		fake: opts.fake ?? false,
		broadcast,
		ports: {
			llm: opts.llm,
			decide: opts.decide ?? rulesDecide(),
			web: {
				configured: false,
				search: async () => [],
				fetch: async () => {
					throw new Error("no");
				},
			},
			clock: new FakeClock(),
		},
		settings: {} as DaemonContext["settings"],
		activity: new ActivityRegistry(),
		services,
		tutor: {
			activeMode: { name: "spotter", description: "d", prompt: "p" },
			latestSteering: opts.steering ?? "",
			answer: async () => "unused",
		} as unknown as DaemonContext["tutor"],
		events: () => [],
		session: () => undefined,
		watchedPath: () => "/sessions/a.jsonl",
		ingestEvent: () => undefined,
		dispatch: async () => false,
	} as DaemonContext;
	const feature = createLanesFeature(context, {
		...(opts.deep ? { deep: opts.deep } : {}),
		tutorRules: "rules",
		newTurnId: () => `t${++turn}`,
	});
	return {
		messages,
		feature,
		services,
		telemetry,
		noted,
		async settled() {
			for (let i = 0; i < 200; i++) {
				if (messages.some((m) => m.type === "turn_settled")) return;
				await Bun.sleep(1);
			}
			throw new Error("turn never settled");
		},
	};
}

const types = (messages: DaemonMessage[]) => messages.map((m) => m.type);

/* ---- tests ---- */

describe("fast lane", () => {
	test("chunks sentences, caps at two, strips markdown", async () => {
		const llm = fakeLlm([
			"**Acks** confirm ",
			"delivery. The producer ",
			"waits for one! Third one.",
		]);
		const spoken: string[] = [];
		const result = await runFastLane({
			llm,
			packet: { system: "s", user: "u" },
			onSentence: (s) => spoken.push(s),
		});
		expect(spoken).toEqual([
			"Acks confirm delivery.",
			"The producer waits for one!",
		]);
		expect(result.text).toBe(
			"Acks confirm delivery. The producer waits for one!",
		);
		expect(result.ttftMs).toBeDefined();
		expect(llm.requests[0]?.lane).toBe("fast");
		expect(llm.requests[0]?.system).toBe("s");
	});

	test("code is replaced with the panel pointer", async () => {
		const spoken: string[] = [];
		await runFastLane({
			llm: fakeLlm(["Here it is.\n\n```ts\nconst x = 1;\n```\n\nDone."]),
			packet: { system: "s", user: "u" },
			onSentence: (s) => spoken.push(s),
		});
		expect(spoken).toEqual(["Here it is.", CODE_REPLACEMENT]);
	});

	test("list items become separate sentences without bullets", () => {
		const { sentences } = takeSentences("Two things:\n- first\n- second\n");
		expect(sentences.length).toBeGreaterThanOrEqual(2);
	});
});

describe("lanes feature turn orchestration", () => {
	test("question: turn_started -> transcript -> fast_answer(s) -> turn_settled", async () => {
		const deep = new StubDeep();
		const learn = stubLearn();
		const h = harness({
			llm: fakeLlm(["Acks confirm delivery. ", "They time out on loss."]),
			deep,
			learn,
		});
		const handled = await h.feature.onClientMessage?.({
			type: "question",
			text: "why does the ack time out?",
			source: "ptt",
			lessonId: "L1",
			sttMs: 120,
		});
		expect(handled).toBe(true);
		await h.settled();
		const seq = types(h.messages).filter((t) =>
			["turn_started", "transcript", "fast_answer", "turn_settled"].includes(t),
		);
		expect(seq).toEqual([
			"turn_started",
			"transcript",
			"fast_answer",
			"fast_answer",
			"turn_settled",
		]);
		expect(h.messages[1]).toMatchObject({ type: "transcript", final: true });
		expect(deep.runs).toHaveLength(1);
		expect(deep.runs[0]?.needsWeb).toBe(false);
		const settled = h.messages.find((m) => m.type === "turn_settled");
		expect(settled?.type === "turn_settled" && settled.telemetry).toMatchObject(
			{
				stt_ms: 120,
				decide_adapter: "rules",
			},
		);
		if (settled?.type === "turn_settled") {
			expect(settled.telemetry.packet_tokens).toBeGreaterThan(0);
			expect(settled.telemetry.decide_ms).toBeDefined();
			expect(settled.telemetry.deep_total_ms).toBeDefined();
		}
		expect(h.telemetry).toHaveLength(1);
		expect(learn.appended.map((m) => m.role)).toEqual([
			"learner",
			"tutor",
			"tutor",
		]);
		expect(h.noted).toEqual([{ id: "t1", text: "Deep answer about acks." }]);
	});

	test("fast_only skips the deep lane", async () => {
		const deep = new StubDeep();
		const h = harness({
			llm: fakeLlm(["Short answer."]),
			decide: rulesDecide("fast_only"),
			deep,
		});
		await h.feature.onClientMessage?.({
			type: "question",
			text: "what is an ack?",
		});
		await h.settled();
		expect(deep.runs).toHaveLength(0);
		expect(types(h.messages)).toContain("fast_answer");
	});

	test("interrupt aborts fast and deep and settles once", async () => {
		const deep = new StubDeep(true);
		const llm = fakeLlm(["Acks "], { hangUntilAbort: true });
		const h = harness({ llm, deep });
		await h.feature.onClientMessage?.({
			type: "question",
			text: "why do acks exist?",
		});
		for (let i = 0; i < 50 && deep.runs.length === 0; i++) await Bun.sleep(1);
		expect(await h.feature.onClientMessage?.({ type: "interrupt" })).toBe(true);
		await h.settled();
		await Bun.sleep(5);
		expect(deep.aborted).toBe(true);
		expect(llm.requests[0]?.signal?.aborted).toBe(true);
		expect(types(h.messages).filter((t) => t === "turn_settled")).toHaveLength(
			1,
		);
		expect(types(h.messages)).not.toContain("daemon_error");
	});

	test("ptt_start interrupts the current turn; ptt_stop is handled", async () => {
		const deep = new StubDeep(true);
		const h = harness({ llm: fakeLlm([], { hangUntilAbort: true }), deep });
		await h.feature.onClientMessage?.({ type: "question", text: "why?" });
		for (let i = 0; i < 50 && deep.runs.length === 0; i++) await Bun.sleep(1);
		expect(await h.feature.onClientMessage?.({ type: "ptt_start" })).toBe(true);
		await h.settled();
		expect(await h.feature.onClientMessage?.({ type: "ptt_stop" })).toBe(true);
		expect(
			await h.feature.onClientMessage?.({ type: "set_mode", name: "x" }),
		).toBe(false);
	});

	test("think_aloud appends to the lesson and says Noted", async () => {
		const learn = stubLearn();
		const llm = fakeLlm(["unused."]);
		const h = harness({ llm, learn });
		await h.feature.onClientMessage?.({
			type: "question",
			text: "I think the ack is lost on reconnect",
		});
		await h.settled();
		expect(learn.appended).toEqual([
			{
				lessonId: "L1",
				role: "learner",
				kind: "think_aloud",
				text: "I think the ack is lost on reconnect",
			},
		]);
		const fast = h.messages.filter((m) => m.type === "fast_answer");
		expect(fast).toEqual([
			{ type: "fast_answer", turnId: "t1", text: "Noted.", speak: false },
		]);
		expect(llm.requests).toHaveLength(0);
	});

	test("bridge_back uses the latest steering prompt, else the fast model", async () => {
		const withSteering = harness({
			llm: fakeLlm([]),
			steering: "Add a test for acks.",
		});
		await withSteering.feature.onClientMessage?.({
			type: "question",
			text: "send that back to Claude",
		});
		await withSteering.settled();
		expect(withSteering.messages).toContainEqual({
			type: "steering_prompt",
			prompt: "Add a test for acks.",
		});

		const llm = fakeLlm([]);
		const generated = harness({ llm });
		await generated.feature.onClientMessage?.({
			type: "question",
			text: "send that back to Claude",
		});
		await generated.settled();
		expect(generated.messages).toContainEqual({
			type: "steering_prompt",
			prompt: "Add a retry with backoff around the ack wait.",
		});
	});

	test("cancel settles without answering", async () => {
		const llm = fakeLlm(["x."]);
		const h = harness({ llm });
		await h.feature.onClientMessage?.({ type: "question", text: "stop" });
		await h.settled();
		expect(llm.requests).toHaveLength(0);
		expect(types(h.messages)).toEqual([
			"turn_started",
			"transcript",
			"turn_settled",
		]);
	});

	test("provider errors become daemon_error and the turn still settles", async () => {
		const llm: LlmPort = {
			isCloud: false,
			// biome-ignore lint/correctness/useYield: throws before yielding
			async *stream() {
				throw new Error("boom");
			},
			async complete() {
				throw new Error("boom");
			},
		};
		const h = harness({ llm, decide: rulesDecide("fast_only") });
		await h.feature.onClientMessage?.({ type: "question", text: "why?" });
		await h.settled();
		expect(h.messages).toContainEqual(
			expect.objectContaining({ type: "daemon_error", scope: "provider" }),
		);
	});

	test("needs_web registers a research job; fake deep emits diagram and quiz without creating orphan cards", async () => {
		const learn = stubLearn();
		const h = harness({
			llm: fakeLlm(["Fake answer."]),
			decide: rulesDecide("needs_web"),
			learn,
			fake: true,
		});
		await h.feature.onClientMessage?.({
			type: "question",
			text: "what is a channel ack",
		});
		await h.settled();
		const update = h.messages.find((m) => m.type === "deep_update");
		expect(
			update?.type === "deep_update" &&
				update.documents.scratchpad_diagram?.diagram,
		).toContain("sequenceDiagram");
		const quiz = h.messages.find((m) => m.type === "question");
		expect(
			quiz?.type === "question" &&
				quiz.question.kind === "quiz" &&
				quiz.question.options,
		).toHaveLength(3);
		expect(learn.cards).toBe(0);
		void FakeDeepLane;
	});
	test("local-only session text never reaches cloud fast or deep lanes", async () => {
		const llm = { ...fakeLlm(["must not answer"]), isCloud: true };
		let deepCalls = 0;
		const h = harness({
			llm,
			deep: {
				async run() {
					deepCalls++;
					return { answer: "must not run" };
				},
			},
			decide: rulesDecide("needs_web"),
		});
		h.services.privacy = {
			isLocalOnly: () => true,
			allowCloud: () => false,
			redact: (text) => text,
			indexIntoGraph: () => false,
		};
		await h.feature.onClientMessage?.({
			type: "question",
			source: "ptt",
			text: "search private secret from my source",
		});
		await h.settled();
		expect(llm.requests).toHaveLength(0);
		expect(deepCalls).toBe(0);
		expect(h.messages.some((message) => message.type === "fast_answer")).toBe(
			false,
		);
	});
	test("a cancelled slow routing decision cannot replace the newer turn", async () => {
		let release = () => {};
		const decide: DecidePort = {
			async decide(task, input, options) {
				if (task === "intent" && input.includes("older"))
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				return certain(options[0] as (typeof options)[number], options, "fake");
			},
		};
		const llm = fakeLlm(["Current answer."]);
		const h = harness({ llm, decide });
		await h.feature.onClientMessage?.({
			type: "question",
			text: "older ambiguous utterance",
		});
		await Bun.sleep(0);
		await h.feature.onClientMessage?.({
			type: "question",
			text: "what is current?",
		});
		await h.settled();
		release();
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(llm.requests).toHaveLength(1);
		expect(llm.requests[0]?.messages[0]?.content).toContain("what is current?");
	});
});
