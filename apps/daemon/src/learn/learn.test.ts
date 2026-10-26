import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityRegistry } from "../activity.ts";
import { FakeClock } from "../ports/clock.ts";
import { certain, type DecidePort, type DecideTask } from "../ports/decide.ts";
import type { LlmPort } from "../ports/llm.ts";
import type {
	Card,
	DaemonMessage,
	LessonDetail,
	Proposition,
} from "../protocol.ts";
import type { GraphService, Services } from "../services.ts";
import { CardStore, type ReviewLogLine, replayCard } from "./cards.ts";
import {
	CARDS_DUE_INTERVAL_MS,
	createLearnFeature,
	RECAP_IDLE_MS,
} from "./feature.ts";
import { derivePlanStatuses, planInit } from "./plan.ts";
import { verdictToRating } from "./questions.ts";
import type { LearnDeps } from "./service.ts";
import { learnTools } from "./tools.ts";

const START = Date.parse("2026-03-01T09:00:00Z");

class StubDecide implements DecidePort {
	choices: Partial<Record<DecideTask, string>> = {};
	calls: Array<{ task: DecideTask; input: string }> = [];
	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
	) {
		this.calls.push({ task, input });
		const choice = (this.choices[task] ?? options[0]) as T;
		return certain(choice, options, "fake");
	}
}

const noLlm: LlmPort = {
	isCloud: false,
	// biome-ignore lint/correctness/useYield: never called in tests
	async *stream() {
		throw new Error("no network in tests");
	},
	async complete() {
		throw new Error("no network in tests");
	},
};

function graphWith(nodes: Proposition[]): GraphService {
	return {
		snapshot: async () => ({ nodes, chains: [], implications: [], groups: [] }),
		search: async (text) =>
			nodes.filter((node) =>
				node.name.toLowerCase().includes(text.toLowerCase()),
			),
		recent: async () => nodes,
		get: async (id) => nodes.find((node) => node.id === id),
		noteProse: () => undefined,
	};
}

const proposition = (id: string, name: string, statement: string) =>
	({
		id,
		name,
		statement,
		sources: [],
		createdAt: new Date(START).toISOString(),
		birthSource: "test",
	}) satisfies Proposition;

let root: string;
let clock: FakeClock;
let decide: StubDecide;
let sent: DaemonMessage[];
let services: Services;

function deps(fake = true): LearnDeps {
	return {
		root,
		fake,
		broadcast: (message) => sent.push(message),
		ports: { decide, llm: noLlm, clock },
		services,
		activity: new ActivityRegistry(),
	};
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sidecar-learn-"));
	clock = new FakeClock(START);
	decide = new StubDecide();
	sent = [];
	services = {};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function call(
	feature: ReturnType<typeof createLearnFeature>,
	method: string,
	path: string,
	body?: unknown,
) {
	const url = new URL(`http://127.0.0.1${path}`);
	const request = new Request(url, {
		method,
		...(body === undefined
			? {}
			: { body: JSON.stringify(body), headers: { "content-type": "json" } }),
	});
	const response = await feature.route?.(request, url, {});
	if (!response) return { status: 0, body: undefined as unknown };
	return { status: response.status, body: (await response.json()) as unknown };
}

describe("T7 FSRS replay", () => {
	test("a fixed review log yields deterministic due dates", async () => {
		const card: Card = {
			id: "card_fixed",
			propositionId: "n_x",
			question: "What does x do?",
			source: { kind: "lesson", lessonId: "les_a", messageId: "m1" },
			createdAt: new Date(START).toISOString(),
		};
		const day = 86_400_000;
		const log: ReviewLogLine[] = [
			{
				cardId: card.id,
				at: new Date(START + 2 * day).toISOString(),
				rating: "hard",
				by: "button",
			},
			{
				cardId: card.id,
				at: new Date(START).toISOString(),
				rating: "good",
				by: "button",
			},
			{
				cardId: "other",
				at: new Date(START).toISOString(),
				rating: "again",
				by: "voice",
			},
		];
		const first = replayCard(card, log);
		const second = replayCard(card, [...log].reverse());
		expect(first.due.toISOString()).toBe(second.due.toISOString());
		expect(first.reps).toBe(2);
		expect(first.due.getTime()).toBeGreaterThan(START + 2 * day);
		// A fresh card is due at creation.
		expect(replayCard(card, []).due.getTime()).toBe(START);

		const store = new CardStore(root, clock);
		const stored = await store.create({
			propositionId: "n_x",
			question: "What does x do?",
			source: card.source,
		});
		expect((await store.due()).map((c) => c.id)).toEqual([stored.id]);
		await store.review(stored.id, "easy", "button");
		expect(await store.due()).toEqual([]);
		const [state] = await store.states();
		const again = await new CardStore(root, clock).states();
		expect(again[0]?.due).toBe(state?.due as number);
		expect(await store.due(state?.due)).toHaveLength(1);
		const mode = (await stat(store.reviewsPath)).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("T8 explain-back", () => {
	test("verdict maps to rating", () => {
		expect(verdictToRating("correct")).toBe("good");
		expect(verdictToRating("partial")).toBe("hard");
		expect(verdictToRating("misconception")).toBe("again");
		expect(verdictToRating("off_topic")).toBe("again");
	});

	test("passed explain-back creates a refresher card and an explain_back review", async () => {
		services.graph = graphWith([
			proposition("n_mask", "causal mask", "A causal mask hides future tokens"),
		]);
		const feature = createLearnFeature(deps());
		const learn = feature.service;
		const lesson = await learn.createLesson({ goal: "Understand attention" });
		decide.choices.explain_back = "partial";
		const question = await learn.askQuestion(lesson.id, {
			kind: "explain_back",
			prompt: "Explain why the decoder needs a mask",
			expectedPropositions: ["n_mask", "n_other"],
		});
		expect(sent).toContainEqual({
			type: "question",
			lessonId: lesson.id,
			question,
		});
		const result = await learn.answer(question.id, "so it cannot peek ahead");
		expect(result).toEqual({ correct: true, verdict: "partial" });
		expect(decide.calls.at(-1)?.input).toContain(
			"causal mask: A causal mask hides future tokens",
		);
		const cards = await learn.cards.cards();
		expect(cards).toHaveLength(1);
		expect(cards[0]?.propositionId).toBe("n_mask");
		expect(cards[0]?.question).toBe("Explain why the decoder needs a mask");
		const reviews = await learn.cards.reviews();
		expect(reviews).toEqual([
			expect.objectContaining({
				cardId: cards[0]?.id,
				rating: "hard",
				by: "explain_back",
				answerText: "so it cannot peek ahead",
			}),
		]);
		// Answering twice is a no-op.
		expect(await learn.answer(question.id, "again")).toBeUndefined();
	});

	test("failed explain-back records the verdict but creates no card", async () => {
		const learn = createLearnFeature(deps()).service;
		const lesson = await learn.createLesson({ goal: "g" });
		decide.choices.explain_back = "misconception";
		const question = await learn.askQuestion(lesson.id, {
			kind: "explain_back",
			prompt: "p",
			expectedPropositions: ["n_a"],
		});
		expect(await learn.answer(question.id, "wrong")).toEqual({
			correct: false,
			verdict: "misconception",
		});
		expect(await learn.cards.cards()).toEqual([]);
		const detail = await learn.lesson(lesson.id);
		expect(detail?.answers[question.id]?.verdict).toBe("misconception");
	});
});

describe("T14 plan", () => {
	const mermaid = [
		"flowchart TD",
		"  %% prerequisites",
		"  A[Vectors] --> B(Dot product)",
		"  B --> C & D",
		"  C[Softmax] --> E[Attention]",
		"  D --> E",
	].join("\n");

	test("parses the subset", () => {
		const plan = planInit(mermaid);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.nodes.map((node) => [node.id, node.label])).toEqual([
			["A", "Vectors"],
			["B", "Dot product"],
			["C", "Softmax"],
			["D", "D"],
			["E", "Attention"],
		]);
		expect(plan.edges).toHaveLength(5);
	});

	test("rejects cycles and bad syntax with line numbers", () => {
		const cycle = planInit("graph LR\nA --> B\nC --> D\nB --> A");
		expect(cycle).toEqual({ ok: false, errors: ["line 4: cycle A -> B -> A"] });
		const bad = planInit("flowchart TD\nA ==> B");
		expect(bad).toEqual({ ok: false, errors: ["line 2: unknown syntax"] });
		const header = planInit("A --> B");
		expect(header.ok).toBe(false);
		if (!header.ok) expect(header.errors[0]).toStartWith("line 1:");
	});

	test("statuses derive from tagged quiz answers", () => {
		const plan = planInit(mermaid);
		if (!plan.ok) throw new Error("parse failed");
		const status = (answers: Array<{ planNode?: string; correct?: boolean }>) =>
			Object.fromEntries(
				derivePlanStatuses(plan.nodes, plan.edges, answers).map((node) => [
					node.id,
					node.status,
				]),
			);
		expect(status([])).toEqual({
			A: "current",
			B: "upcoming",
			C: "upcoming",
			D: "upcoming",
			E: "upcoming",
		});
		expect(
			status([
				{ planNode: "A", correct: true },
				{ planNode: "B", correct: false },
			]),
		).toMatchObject({ A: "visited", B: "current" });
		expect(
			status([
				{ planNode: "A", correct: true },
				{ planNode: "B", correct: true },
				{ planNode: "C", correct: true },
			]),
		).toMatchObject({ C: "visited", D: "current", E: "upcoming" });
	});

	test("tools drive phases and plan statuses end to end", async () => {
		const learn = createLearnFeature(deps()).service;
		const tools = Object.fromEntries(
			learnTools(learn).map((tool) => [tool.name, tool]),
		);
		await expect(tools.queue_gap?.execute({ topic: "x" })).rejects.toThrow(
			"No active lesson",
		);
		const lesson = await learn.createLesson({ goal: "Learn attention" });
		expect(lesson.phase).toBe("measure");
		for (let i = 0; i < 3; i++) {
			const q = await learn.askQuestion(lesson.id, {
				kind: "ask",
				prompt: `Probe ${i}`,
			});
			await learn.answer(q.id, "initial understanding");
		}
		await tools.set_measure?.execute({
			levels: { vectors: "solid", softmax: "new" },
		});
		expect((await learn.lesson(lesson.id))?.phase).toBe("plan");
		await expect(
			tools.plan_init?.execute({ mermaid: "graph TD\nA --> B\nB --> A" }),
		).rejects.toThrow("line 3: cycle");
		await tools.plan_init?.execute({
			mermaid: "graph TD\nA[Vectors] --> B[Softmax]",
		});
		await expect(
			tools.plan_init?.execute({ mermaid: "graph TD\nA --> C" }),
		).rejects.toThrow("authored once");
		await tools.ask_question?.execute({
			kind: "quiz",
			prompt: "Which is a vector?",
			options: [
				{ id: "a", label: "[1, 2]" },
				{ id: "b", label: "3" },
			],
			correctId: "a",
			planNode: "A",
		});
		let detail = (await learn.lesson(lesson.id)) as LessonDetail;
		expect(detail.phase).toBe("teach");
		const quiz = detail.questions.at(-1);
		expect(quiz?.kind).toBe("quiz");
		await learn.answer(quiz?.id as string, "a");
		await tools.queue_gap?.execute({ topic: "eigenvalues" });
		detail = (await learn.lesson(lesson.id)) as LessonDetail;
		expect(detail.planNodes).toEqual([
			{ id: "A", label: "Vectors", status: "visited" },
			{ id: "B", label: "Softmax", status: "current" },
		]);
		expect(detail.queuedGaps).toEqual(["eigenvalues"]);
		expect(detail.answers[quiz?.id as string]).toEqual({
			value: "a",
			correct: true,
		});
		const created = await tools.create_card?.execute({
			propositionId: "n_vec",
			question: "What makes something a vector?",
		});
		expect(created).toStartWith("Card ");
		await tools.add_lesson_source?.execute({
			source: { kind: "run", path: "/tmp/run.jsonl", metric: "loss" },
		});
		expect((await learn.lesson(lesson.id))?.sources).toHaveLength(1);
	});
});

describe("routes and client messages", () => {
	test("lessons CRUD and sources validation", async () => {
		const feature = createLearnFeature(deps());
		expect(await call(feature, "GET", "/api/lessons")).toEqual({
			status: 200,
			body: { lessons: [] },
		});
		expect((await call(feature, "POST", "/api/lessons", {})).status).toBe(400);
		expect(
			(await call(feature, "POST", "/api/lessons", { goal: "x".repeat(501) }))
				.status,
		).toBe(400);
		const goal =
			"Understand how gradient accumulation interacts with the learning rate schedule in my training loop";
		const created = await call(feature, "POST", "/api/lessons", { goal });
		expect(created.status).toBe(200);
		const first = (created.body as { lesson: LessonDetail }).lesson;
		expect(first.title.length).toBeLessThanOrEqual(80);
		expect(first.title).toEndWith("...");
		expect(first.phase).toBe("measure");
		expect(sent).toContainEqual({ type: "lessons_changed" });
		clock.advance(1000);
		const second = (
			(
				await call(feature, "POST", "/api/lessons", {
					goal: "Two",
					title: "Second",
					anchors: [{ kind: "file", path: "/repo/a.ts", lines: [1, 4] }],
					sessionPath: "/s.jsonl",
				})
			).body as { lesson: LessonDetail }
		).lesson;
		expect(second.anchors).toHaveLength(1);
		expect(feature.service.activeLessonId()).toBe(second.id);
		const list = (await call(feature, "GET", "/api/lessons")).body as {
			lessons: LessonDetail[];
		};
		expect(list.lessons.map((lesson) => lesson.id)).toEqual([
			second.id,
			first.id,
		]);

		const detail = await call(feature, "GET", `/api/lessons/${first.id}`);
		expect(detail.status).toBe(200);
		expect(detail.body).toMatchObject({
			id: first.id,
			messages: [],
			questions: [expect.objectContaining({ kind: "ask" })],
			planNodes: [],
			sources: [],
		});
		expect(
			(await call(feature, "GET", "/api/lessons/les_missing")).status,
		).toBe(404);
		expect((await call(feature, "GET", "/api/lessons/..%2Fx")).status).toBe(
			404,
		);

		const sourcesPath = `/api/lessons/${first.id}/sources`;
		for (const bad of [
			{ kind: "pdf", path: "/p.pdf" },
			{ kind: "web" },
			{ kind: "nope", path: "x" },
			"string",
		]) {
			expect(
				(await call(feature, "POST", sourcesPath, { source: bad })).status,
			).toBe(400);
		}
		const withPdf = await call(feature, "POST", sourcesPath, {
			source: { kind: "pdf", path: "/p.pdf", page: 3, quote: "q" },
		});
		expect(withPdf.status).toBe(200);
		expect((withPdf.body as LessonDetail).sources).toHaveLength(1);
		await call(feature, "POST", sourcesPath, {
			source: { kind: "web", url: "https://example.com" },
		});
		for (let i = 0; i < 22; i++)
			await call(feature, "POST", sourcesPath, {
				source: { kind: "run", path: `/r${i}.jsonl` },
			});
		const full = await call(feature, "POST", sourcesPath, {
			source: { kind: "run", path: "/one-too-many.jsonl" },
		});
		expect(full.status).toBe(400);
		expect((await feature.service.lesson(first.id))?.sources).toHaveLength(24);

		await feature.service.appendMessage(first.id, {
			role: "tutor",
			kind: "text",
			text: "hello",
		});
		const raw = JSON.parse(
			await readFile(join(root, "lessons", `${first.id}.json`), "utf8"),
		);
		expect(raw.messages[0].text).toBe("hello");
		expect(await call(feature, "GET", "/api/unrelated")).toEqual({
			status: 0,
			body: undefined,
		});
	});

	test("due cards route, grade message, onConnect count and periodic broadcast", async () => {
		const feature = createLearnFeature(deps());
		feature.start?.();
		const card = await feature.service.createCard({
			propositionId: "n_a",
			question: "Q?",
			source: { kind: "lesson", lessonId: "les_x", messageId: "m" },
		});
		const due = await call(feature, "GET", "/api/cards/due");
		expect(due.body).toEqual({ cards: [card] });
		const onConnect: DaemonMessage[] = [];
		feature.onConnect?.((message) => onConnect.push(message));
		await Bun.sleep(5);
		expect(onConnect).toEqual([{ type: "cards_due", count: 1 }]);
		sent = [];
		expect(
			await feature.onClientMessage?.({
				type: "grade",
				cardId: card.id,
				rating: "good",
			}),
		).toBe(true);
		expect(sent).toContainEqual({ type: "cards_due", count: 0 });
		const reviews = await feature.service.cards.reviews();
		expect(reviews[0]).toMatchObject({ cardId: card.id, by: "button" });
		sent = [];
		clock.advance(CARDS_DUE_INTERVAL_MS);
		await Bun.sleep(5);
		expect(sent).toContainEqual({ type: "cards_due", count: 0 });
		feature.stop?.();
	});

	test("answer message grades a quiz and broadcasts lessons_changed", async () => {
		const feature = createLearnFeature(deps());
		const lesson = await feature.service.createLesson({ goal: "g" });
		const question = await feature.service.askQuestion(lesson.id, {
			kind: "ask",
			prompt: "What do you already know?",
		});
		sent = [];
		expect(
			await feature.onClientMessage?.({
				type: "answer",
				questionId: question.id,
				value: "a bit",
			}),
		).toBe(true);
		expect(sent).toContainEqual({ type: "lessons_changed" });
		const detail = await feature.service.lesson(lesson.id);
		expect(detail?.answers[question.id]).toEqual({ value: "a bit" });
	});

	test("dead-air refresher prompts on matching diffs, respects DND and cooldown", async () => {
		services.graph = graphWith([
			proposition(
				"n_lr",
				"learning rate warmup",
				"Warmup ramps the learning rate linearly over the first steps",
			),
		]);
		const feature = createLearnFeature(deps());
		const card = await feature.service.createCard({
			propositionId: "n_lr",
			question: "Why ramp before the full rate?",
			source: { kind: "lesson", lessonId: "les_x", messageId: "m" },
		});
		decide.choices.nudge_gate = "nudge";
		const edit = {
			timestamp: new Date(START).toISOString(),
			event_type: "tool_call" as const,
			headline: "Edit train.py",
			details: "",
			diff: "+ warmup_steps = 500\n+ lr = base_lr * min(1, step / warmup_steps)  # learning rate",
		};
		const prompts = () =>
			sent.filter((message) => message.type === "card_prompt");

		expect(await feature.onClientMessage?.({ type: "dnd", on: true })).toBe(
			false,
		);
		feature.onEvent?.(edit);
		await Bun.sleep(10);
		expect(prompts()).toEqual([]);

		await feature.onClientMessage?.({ type: "dnd", on: false });
		feature.onEvent?.({ ...edit, diff: "+ print('unrelated change')" });
		await Bun.sleep(10);
		expect(prompts()).toEqual([]);

		feature.onEvent?.(edit);
		await Bun.sleep(10);
		expect(prompts()).toEqual([{ type: "card_prompt", card }]);

		feature.onEvent?.(edit);
		await Bun.sleep(10);
		expect(prompts()).toHaveLength(1);

		clock.advance(10 * 60_000);
		await Bun.sleep(10);
		decide.choices.nudge_gate = "hold";
		feature.onEvent?.(edit);
		await Bun.sleep(10);
		expect(prompts()).toHaveLength(1);
		decide.choices.nudge_gate = "nudge";
		feature.onEvent?.(edit);
		await Bun.sleep(10);
		expect(prompts()).toHaveLength(2);
		feature.stop?.();
	});

	test("recap: route and idle trigger produce cards from noted concepts", async () => {
		services.graph = graphWith([
			proposition(
				"n_ga",
				"gradient accumulation",
				"Sum grads over micro-batches",
			),
		]);
		const feature = createLearnFeature(deps(true));
		const learn = feature.service;
		await learn.noteConcept({
			concept: "gradient accumulation",
			why: "used in train.py",
		});
		await learn.noteConcept({ concept: "Mixed precision" });
		await learn.noteConcept({ concept: "mixed precision" });
		expect(await learn.recentNotes(2)).toHaveLength(2);
		clock.advance(1000);
		const result = await call(feature, "POST", "/api/recap");
		expect(result.status).toBe(200);
		const cards = (result.body as { cards: Card[] }).cards;
		expect(cards.map((card) => card.propositionId).sort()).toEqual(["n_ga"]);
		expect(cards.every((card) => !card.question.includes("Sum grads"))).toBe(
			true,
		);

		// Nothing new: a second recap creates nothing.
		expect((await call(feature, "POST", "/api/recap")).body).toEqual({
			cards: [],
		});

		// Idle trigger after activity.
		clock.advance(1000);
		await learn.noteConcept({ concept: "warmup" });
		feature.onEvent?.({
			timestamp: new Date(clock.now()).toISOString(),
			event_type: "agent_message",
			headline: "done",
			details: "",
		});
		clock.advance(RECAP_IDLE_MS - 1);
		await Bun.sleep(5);
		expect(await learn.cards.cards()).toHaveLength(1);
		clock.advance(1);
		await Bun.sleep(20);
		const all = await learn.cards.cards();
		expect(all.map((card) => card.propositionId)).toEqual(["n_ga"]);
		feature.stop?.();
	});

	test("recap uses the deep lane JSON output when not in fake mode", async () => {
		services.graph = graphWith([
			proposition("n_softmax", "softmax", "Softmax outputs sum to one"),
			proposition(
				"n_temp",
				"temperature",
				"Temperature controls sampling sharpness",
			),
			proposition("n_logits", "logits", "Logits are unnormalized scores"),
		]);
		const requests: unknown[] = [];
		const llm: LlmPort = {
			isCloud: false,
			// biome-ignore lint/correctness/useYield: unused
			async *stream() {
				throw new Error("unused");
			},
			async complete(request) {
				requests.push(request);
				return JSON.stringify({
					cards: [
						{
							concept: "softmax",
							question: "What does softmax output sum to?",
						},
						{
							concept: "temperature",
							question: "What happens as temperature rises?",
						},
						{
							concept: "logits",
							question: "Where do logits come from in your model?",
						},
					],
				});
			},
		};
		const feature = createLearnFeature({
			...deps(false),
			ports: { decide, llm, clock },
		});
		const lesson = await feature.service.createLesson({ goal: "sampling" });
		await feature.service.appendMessage(lesson.id, {
			role: "tutor",
			kind: "text",
			text: "Softmax turns logits into probabilities.",
		});
		clock.advance(1000);
		const cards = await feature.service.recap();
		expect(cards).toHaveLength(3);
		expect(requests[0]).toMatchObject({ lane: "deep", json: true });
		expect(cards[0]?.source).toMatchObject({
			kind: "lesson",
			lessonId: lesson.id,
		});
	});
});
