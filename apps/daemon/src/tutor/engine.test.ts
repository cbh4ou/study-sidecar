import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { SessionEvent } from "../ingest/events.ts";
import { findRepoOkf, OKFStore } from "../memory/okf-store.ts";
import type { TutorMode } from "../modes/modes.ts";
import { classifyDelta, TutorEngine, type TutorMessage } from "./engine.ts";
import { openTutorHarness, type TutorHarness } from "./harness.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const mode: TutorMode = {
	name: "test",
	title: "Test",
	description: "",
	chattiness: { cooldown_sec: 0, max_proactive_per_10m: 3 },
	wake_triggers: { on_tools: ["write", "edit", "bash"], on_dead_air_ms: 0 },
	voice: {},
	prompt: "Be concise.",
	source: "test",
};
const event = (
	tool_name: string,
	details: string,
	extra: Partial<{
		event_type: "tool_call" | "tool_result";
		headline: string;
		is_error: boolean;
		metadata: Record<string, unknown>;
		file_path: string;
		session_file: string;
	}> = {},
) => ({
	timestamp: new Date().toISOString(),
	event_type: extra.event_type ?? ("tool_call" as const),
	headline: extra.headline ?? `Execute: ${tool_name}`,
	details,
	tool_name,
	...extra,
});

type ScriptedEngine = {
	engine: TutorEngine;
	harness: TutorHarness;
	faux: FauxProviderHandle;
};

/** An engine driven by the real durable harness on a faux scripted model. */
async function scriptedEngine(options: {
	home: string;
	deadAirSeconds?: number;
	activeMode?: TutorMode;
	events?: SessionEvent[];
	respond?: (call: number) => string;
	failWith?: string;
	onMessage?: (message: TutorMessage) => void;
}): Promise<ScriptedEngine> {
	const faux = fauxProvider({
		provider: "sidecar",
		models: [{ id: "tutor-test", contextWindow: 32_000, maxTokens: 4_000 }],
	});
	const respond = options.respond ?? (() => "ok");
	const step = (
		_context: unknown,
		_options: unknown,
		state: { callCount: number },
	) => {
		faux.appendResponses([step]);
		if (options.failWith)
			return fauxAssistantMessage(options.failWith, {
				stopReason: "error",
				errorMessage: options.failWith,
			});
		return fauxAssistantMessage(respond(state.callCount));
	};
	faux.setResponses([step]);
	const activeMode = options.activeMode ?? mode;
	const memory = new OKFStore(join(options.home, ".study-sidecar", ".okf"));
	const harness = await openTutorHarness({
		home: options.home,
		modelSlug: "unused-test",
		memory,
		mode: () => activeMode,
		events: () => options.events ?? [],
		sessionCwd: () => undefined,
		sourceSession: () => "standalone",
		tutorProvider: { provider: faux.provider, modelId: "tutor-test" },
		retryMaxRetries: 0,
	});
	const engine = new TutorEngine(
		activeMode,
		(message) => options.onMessage?.(message),
		{
			harness,
			memory,
			deadAirSeconds: options.deadAirSeconds,
			home: options.home,
		},
	);
	return { engine, harness, faux };
}

describe("OKF and tutor pipeline", () => {
	test("saves sanitized cards atomically and updates instead of replacing", async () => {
		const root = await mkdtemp("/tmp/sidecar-okf-");
		temporary.push(root);
		const store = new OKFStore(root);
		await store.saveConcept("A: title\n---", "first", ["typescript"]);
		const path = await store.saveConcept("A: title\n---", "second", [
			"typescript",
		]);
		const card = await readFile(path, "utf8");
		expect(card).toContain('title: "A: title"');
		expect(card).toContain("## Update");
		expect(card).not.toContain("\n---\n---");
	});

	test("keeps learner and repo fallback retrieval isolated", async () => {
		const root = await mkdtemp("/tmp/sidecar-memory-");
		temporary.push(root);
		const learner = new OKFStore(join(root, "learner"));
		const repo = new OKFStore(join(root, "repo/.okf"));
		await learner.saveConcept("Learner TypeScript", "learner-only detail", [
			"typescript",
		]);
		await repo.saveConcept("Repo TypeScript", "repo-only detail", [
			"typescript",
		]);
		const bundles = (
			await learner.query("typescript", join(root, "repo/.okf"))
		).map((hit) => hit.bundle);
		expect(bundles.sort()).toEqual(["learner", "repo"]);
		expect(
			(await learner.query("learner-only")).map((hit) => hit.title),
		).toEqual(["Learner TypeScript"]);
		expect(await findRepoOkf(join(root, "repo/src/nested"))).toBe(
			join(root, "repo/.okf"),
		);
	});

	test("answers through the durable harness and persists the transcript", async () => {
		const home = await mkdtemp("/tmp/sidecar-engine-");
		temporary.push(home);
		const messages: TutorMessage[] = [];
		const { promise: ambientSeen, resolve: resolveAmbient } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			respond: (call) =>
				call >= 2
					? "The tailer reads appended bytes.\n```mermaid\nflowchart LR\n  A[JSONL] --> B[Coach]\n```"
					: `answer ${call}`,
			onMessage: (message) => {
				messages.push(message);
				if (message.type === "ambient_insight") resolveAmbient();
			},
		});
		// A read is not a wake tool: gate-2 keeps it SILENT.
		engine.observe(event("read", "routine read"));
		expect(messages).toEqual([]);
		// A small edit is an AMBIENT_PILL: insight, no steering.
		engine.observe(event("edit", "small edit"));
		await ambientSeen;
		expect(messages.some((message) => message.type === "ambient_insight")).toBe(
			true,
		);
		expect(messages.some((message) => message.type === "steering_prompt")).toBe(
			false,
		);
		// A direct answer flows through the durable conversation with mermaid.
		const answer = await engine.answer("What happened?");
		expect(answer).toContain("tailer");
		const emitted = messages.find(
			(message) => message.type === "tutor_answer",
		) as { mermaid?: string } | undefined;
		expect(emitted?.mermaid).toBe("flowchart LR\n  A[JSONL] --> B[Coach]");
		expect(engine.latestSteering).not.toBe("");
		// The durable transcript lives in the sidecar-owned sqlite store.
		const storage = join(home, ".study-sidecar", "tutor.sqlite");
		expect((await stat(storage)).mode & 0o777).toBe(0o600);
		expect((await stat(storage)).size).toBeGreaterThan(0);
		await engine.close();
	});
});

describe("TutorEngine session behavior", () => {
	test("arms dead-air after Write, Edit, and an agent turn boundary", async () => {
		const home = await mkdtemp("/tmp/sidecar-dead-air-");
		temporary.push(home);
		const commands: string[] = [];
		const { promise: wrote, resolve: resolveWrite } =
			Promise.withResolvers<void>();
		const { promise: edited, resolve: resolveEdit } =
			Promise.withResolvers<void>();
		const { promise: endedTurn, resolve: resolveTurn } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			deadAirSeconds: 1,
			onMessage: (message) => {
				if (message.type !== "dead_air_insight") return;
				commands.push(message.command ?? "");
				if (commands.length === 1) resolveWrite();
				if (commands.length === 2) resolveEdit();
				if (commands.length === 3) resolveTurn();
			},
		});
		vi.useFakeTimers();
		try {
			engine.observe(event("write", "small", { file_path: "write.ts" }));
			vi.advanceTimersByTime(1_000);
			await wrote;
			engine.reset();
			engine.observe(event("edit", "small", { file_path: "edit.ts" }));
			vi.advanceTimersByTime(1_000);
			await edited;
			engine.reset();
			engine.observe(event("write", "small", { file_path: "turn.ts" }));
			engine.observe({
				timestamp: new Date().toISOString(),
				event_type: "agent_message",
				headline: "Agent: waiting",
				details: "waiting",
			});
			vi.advanceTimersByTime(1_000);
			await endedTurn;
		} finally {
			vi.useRealTimers();
		}
		expect(commands).toEqual(["write.ts", "edit.ts", "Agent: waiting"]);
		await engine.close();
	});

	test("caps proactive coaching inside the rolling budget", async () => {
		const home = await mkdtemp("/tmp/sidecar-budget-");
		temporary.push(home);
		const messages: TutorMessage[] = [];
		const { promise: steered, resolve: resolveSteering } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			activeMode: {
				...mode,
				chattiness: { ...mode.chattiness, max_proactive_per_10m: 1 },
			},
			onMessage: (message) => {
				messages.push(message);
				if (message.type === "steering_prompt") resolveSteering();
			},
		});
		engine.observe(event("edit", "x".repeat(401)));
		await steered;
		const messageCount = messages.length;
		engine.observe(
			event("edit", "y".repeat(401), { headline: "@@ blocked.ts :: f" }),
		);
		await Promise.resolve();
		expect(messages).toHaveLength(messageCount);
		await engine.close();
	});

	test("emits the last Mermaid diagram and voice hint", async () => {
		const home = await mkdtemp("/tmp/sidecar-answer-");
		temporary.push(home);
		const messages: TutorMessage[] = [];
		const { engine } = await scriptedEngine({
			home,
			activeMode: {
				...mode,
				voice: { language: "en", accent: "british", speed: 1.2 },
			},
			respond: () =>
				"first\n```mermaid\ngraph TD\nA-->B\n```\nlast\n```mermaid\ngraph TD\nB-->C\n```",
			onMessage: (message) => messages.push(message),
		});
		await engine.answer("What changed?");
		expect(
			messages.find((message) => message.type === "tutor_answer"),
		).toMatchObject({
			mermaid: "graph TD\nB-->C",
			voice: { language: "en", speed: 1.2, voice: "british" },
		});
		await engine.close();
	});
});

describe("classifyDelta", () => {
	test("SILENT for non-wake tools and quick clean bash results", () => {
		expect(classifyDelta(event("read", "text"), mode, [])).toBe("SILENT");
		expect(
			classifyDelta(
				event("write", "text"),
				{ ...mode, wake_triggers: { ...mode.wake_triggers, on_tools: [] } },
				[],
			),
		).toBe("SILENT");
		expect(
			classifyDelta(
				event("bash", "done", { event_type: "tool_result" }),
				mode,
				[],
			),
		).toBe("SILENT");
	});

	test("AMBIENT_PILL for guardrail findings and small diffs", () => {
		expect(classifyDelta(event("write", "small"), mode, ["finding"])).toBe(
			"AMBIENT_PILL",
		);
		expect(classifyDelta(event("edit", "small diff"), mode, [])).toBe(
			"AMBIENT_PILL",
		);
	});

	test("PROACTIVE_COACH for errors, big diffs, and slow bash", () => {
		expect(
			classifyDelta(event("read", "x", { is_error: true }), mode, []),
		).toBe("PROACTIVE_COACH");
		expect(classifyDelta(event("edit", "x".repeat(401)), mode, [])).toBe(
			"PROACTIVE_COACH",
		);
		expect(
			classifyDelta(
				event("edit", "small", { headline: "@@ a.ts :: fn" }),
				mode,
				[],
			),
		).toBe("PROACTIVE_COACH");
		expect(
			classifyDelta(
				event("bash", "timed out", {
					event_type: "tool_result",
					metadata: { duration_ms: 15_000 },
				}),
				mode,
				[],
			),
		).toBe("PROACTIVE_COACH");
	});
});

describe("daemon error surfacing", () => {
	test("failing generation emits daemon_error with insight and provider scopes", async () => {
		const home = await mkdtemp("/tmp/sidecar-fail-");
		temporary.push(home);
		const messages: TutorMessage[] = [];
		const { promise: insightError, resolve: resolveInsightError } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			failWith: "boom",
			onMessage: (message) => {
				messages.push(message);
				if (message.type === "daemon_error" && message.scope === "insight")
					resolveInsightError();
			},
		});
		engine.observe(event("edit", "x".repeat(401)));
		await insightError;
		const scopes = messages
			.filter((message) => message.type === "daemon_error")
			.map((message) => message.scope);
		expect(scopes).toContain("provider");
		expect(scopes).toContain("insight");
		await engine.close();
	});

	test("provider construction failures emit provider scope at most once per 60s", async () => {
		const home = await mkdtemp("/tmp/sidecar-provider-");
		temporary.push(home);
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const messages: TutorMessage[] = [];
			let insightErrors = 0;
			const { promise: secondError, resolve: resolveSecond } =
				Promise.withResolvers<void>();
			const engine = new TutorEngine(
				mode,
				(message) => {
					messages.push(message);
					if (
						message.type === "daemon_error" &&
						message.scope === "insight" &&
						++insightErrors === 2
					)
						resolveSecond();
				},
				{ home },
			);
			engine.observe(event("edit", "x".repeat(401)));
			engine.observe(event("edit", "y".repeat(401)));
			await secondError;
			expect(
				messages.filter(
					(message) =>
						message.type === "daemon_error" && message.scope === "provider",
				),
			).toHaveLength(1);
			expect(insightErrors).toBeGreaterThanOrEqual(2);
		} finally {
			process.env.HOME = previousHome;
		}
	});
});

describe("provider backoff", () => {
	test("proactive generation pauses for the backoff window after a provider failure", async () => {
		const home = await mkdtemp("/tmp/sidecar-backoff-");
		temporary.push(home);
		const messages: Array<Record<string, unknown>> = [];
		const { promise: settled, resolve: resolveSettled } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			failWith: "HTTP 429",
			onMessage: (message) => {
				messages.push(message);
				if (message.type === "daemon_error" && message.scope === "insight")
					resolveSettled();
			},
		});
		engine.observe(event("edit", "x".repeat(500))); // first attempt fails
		await settled;
		const messageCount = messages.length;
		await engine.observe(
			event("edit", "x".repeat(500), { headline: "second" }),
		);
		await engine.observe(event("edit", "x".repeat(500), { headline: "third" }));
		expect(messages).toHaveLength(messageCount); // no further attempts during backoff
		await engine.close();
	});

	test("direct questions still attempt generation during backoff", async () => {
		const home = await mkdtemp("/tmp/sidecar-backoff-2-");
		temporary.push(home);
		const { promise: providerFailed, resolve: resolveProviderFailed } =
			Promise.withResolvers<void>();
		const { engine } = await scriptedEngine({
			home,
			failWith: "HTTP 429",
			onMessage: (message) => {
				if (message.type === "daemon_error" && message.scope === "provider")
					resolveProviderFailed();
			},
		});
		engine.observe(event("edit", "y".repeat(500)));
		await providerFailed;
		await expect(engine.answer("what happened?")).rejects.toThrow();
		await engine.close();
	});
});

describe("durable session recovery", () => {
	test("simultaneous first questions share one harness open", async () => {
		const { promise: release, resolve } = Promise.withResolvers<void>();
		let opens = 0;
		const harness: TutorHarness = {
			converse: async () => "answer",
			updateDocuments: async () => {},
			close: async () => {},
		};
		const engine = new TutorEngine(mode, () => {}, {
			openHarness: async () => {
				opens++;
				await release;
				return harness;
			},
		});
		const answers = Promise.all([engine.answer("one"), engine.answer("two")]);
		await Bun.sleep(0);
		resolve();
		expect(await answers).toEqual(["answer", "answer"]);
		expect(opens).toBe(1);
		await engine.close();
	});

	test("a poisoned durable session is closed and reopened on the next attempt", async () => {
		const home = await mkdtemp("/tmp/sidecar-reopen-err-");
		temporary.push(home);
		const messages: TutorMessage[] = [];
		let closed = false;
		const poisoned: TutorHarness = {
			converse: () => {
				throw new Error("ID 41 already belongs to entry");
			},
			updateDocuments: async () => {},
			close: async () => {
				closed = true;
			},
		};
		const engine = new TutorEngine(mode, (message) => messages.push(message), {
			home,
			harness: poisoned,
		});
		await expect(engine.answer("hello")).rejects.toThrow("already belongs");
		expect(closed).toBe(true);
		// The next attempt must reopen a fresh harness (which, on this bare
		// temp HOME with no pi registry, fails with the model error — not the
		// storage error again).
		await expect(engine.answer("again")).rejects.toThrow("unavailable");
		const storage = messages.filter(
			(message) =>
				message.type === "daemon_error" &&
				message.message.includes("already belongs"),
		);
		expect(storage).toHaveLength(1);
	});
});
