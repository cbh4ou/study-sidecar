import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { OKFStore } from "../memory/okf-store.ts";
import type { TutorMode } from "../modes/modes.ts";
import type { TutorDocuments } from "../protocol.ts";
import { openTutorHarness } from "./harness.ts";

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
	wake_triggers: { on_tools: [], on_dead_air_ms: 0 },
	voice: {},
	prompt: "Be concise.",
	source: "test",
};

async function harness(
	home: string,
	options: {
		cwd?: string;
		sourceScope?: string;
		allowCloud?: (path?: string) => boolean;
		onDocuments?: (documents: TutorDocuments) => void;
	} = {},
) {
	const faux = fauxProvider({
		provider: "sidecar",
		models: [{ id: "tutor-test", contextWindow: 32_000, maxTokens: 4_000 }],
	});
	const memory = new OKFStore(join(home, ".study-sidecar", ".okf"));
	const tutor = await openTutorHarness({
		home,
		modelSlug: "unused-test",
		memory,
		mode: () => mode,
		events: () => [],
		sessionCwd: () => options.cwd,
		sourceSession: () => "session-h",
		tutorProvider: { provider: faux.provider, modelId: "tutor-test" },
		retryMaxRetries: 0,
		onDocuments: options.onDocuments,
		sourceScope: options.sourceScope,
		allowCloud: options.allowCloud,
	});
	return { tutor, faux, memory };
}

describe("tutor durable harness", () => {
	test("runs model tool calls durably: save_okf_concept_card writes a real card", async () => {
		const home = await mkdtemp("/tmp/sidecar-harness-");
		temporary.push(home);
		const { tutor, faux, memory } = await harness(home);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("save_okf_concept_card", {
						title: "Byte-offset tailing",
						body: "Reads only the appended slice",
						topics: ["ingest"],
						mermaid: "flowchart LR\n  A[JSONL] --> B[Coach]",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Saved the card."),
		]);
		const answer = await tutor.converse("Teach me about the tailer.");
		expect(answer).toContain("Saved the card.");
		const cards = await memory.query("byte-offset tailing");
		expect(cards.map((card) => card.title)).toContain("Byte-offset tailing");
		const storage = join(home, ".study-sidecar", "tutor.sqlite");
		expect((await stat(storage)).mode & 0o777).toBe(0o600);
		await tutor.close();
	});

	test("scratchpads stay inside the tutor workspace", async () => {
		const home = await mkdtemp("/tmp/sidecar-scratch-");
		temporary.push(home);
		const { tutor, faux } = await harness(home);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write_study_scratchpad", {
						name: "research",
						content: "notes",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("noted"),
		]);
		await tutor.converse("keep some notes");
		const scratch = join(home, ".study-sidecar", "workspace", "scratch");
		expect(await readdir(scratch)).toEqual(["research.md"]);
		expect((await stat(join(scratch, "research.md"))).mode & 0o777).toBe(0o600);
		await tutor.close();
	});

	test("commits validated Mermaid and HUD artifacts as durable documents", async () => {
		const home = await mkdtemp("/tmp/sidecar-mmd-");
		temporary.push(home);
		const documents: TutorDocuments[] = [];
		const { promise: artifacts, resolve: resolveArtifacts } =
			Promise.withResolvers<void>();
		const { tutor, faux } = await harness(home, {
			onDocuments: (value) => {
				documents.push(value);
				if (
					value.hud_state.status === "speaking" &&
					value.scratchpad_diagram.diagram
				)
					resolveArtifacts();
			},
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("update_mermaid_canvas", {
						diagram: "flowchart LR\nA --> B",
					}),
					fauxToolCall("emit_hud_artifacts", {
						status: "speaking",
						message: "Follow the flow",
						steering_prompt: "Inspect the boundary.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("checked"),
		]);
		await tutor.converse("check this diagram");
		await artifacts;
		expect(
			await readFile(
				join(
					home,
					".study-sidecar",
					"workspace",
					"scratch",
					"current-canvas.mmd",
				),
				"utf8",
			),
		).toContain("flowchart LR");
		expect(documents.at(-1)).toMatchObject({
			hud_state: { status: "speaking", message: "Follow the flow" },
			scratchpad_diagram: { diagram: "flowchart LR\nA --> B" },
			steering_prompt: { prompt: "Inspect the boundary." },
		});
		await tutor.close();
	});

	test("reads the watched repository without writing to it", async () => {
		const home = await mkdtemp("/tmp/sidecar-readonly-");
		temporary.push(home);
		const repo = join(home, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "lesson.ts"), "export const lesson = 1;\n");
		const before = await readdir(repo);
		const { tutor, faux } = await harness(home, { cwd: repo });
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("read_watched_repo_file", { path: "lesson.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("read"),
		]);
		await tutor.converse("inspect the lesson");
		expect(await readdir(repo)).toEqual(before);
		expect(await readFile(join(repo, "lesson.ts"), "utf8")).toBe(
			"export const lesson = 1;\n",
		);
		await tutor.close();
	});

	test("conversation persists across harness reopen", async () => {
		const home = await mkdtemp("/tmp/sidecar-reopen-");
		temporary.push(home);
		const first = await harness(home);
		first.faux.setResponses([fauxAssistantMessage("first answer")]);
		expect(await first.tutor.converse("hello")).toBe("first answer");
		await first.tutor.close();
		const second = await harness(home);
		second.faux.setResponses([fauxAssistantMessage("second answer")]);
		expect(await second.tutor.converse("again")).toBe("second answer");
		await second.tutor.close();
	});

	test("overlapping tutor requests keep durable entry IDs distinct", async () => {
		const home = await mkdtemp("/tmp/sidecar-overlap-");
		temporary.push(home);
		const { tutor, faux } = await harness(home);
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		const answers = await Promise.all([
			tutor.converse("first question"),
			tutor.converse("second question"),
		]);
		expect(answers).toEqual(["first answer", "second answer"]);
		await tutor.close();
	});
	test("source scopes isolate and restore durable documents", async () => {
		const home = await mkdtemp("/tmp/sidecar-scopes-");
		temporary.push(home);
		const first = await harness(home, { sourceScope: "private-session" });
		await first.tutor.updateDocuments({
			scratchpad_diagram: { diagram: "flowchart LR\nA[Private]-->B[First]" },
		});
		await first.tutor.close();
		let other: TutorDocuments | undefined;
		const second = await harness(home, {
			sourceScope: "public-session",
			onDocuments: (d) => {
				other = d;
			},
		});
		expect(other?.scratchpad_diagram.diagram).toBe("");
		await second.tutor.close();
		let restored: TutorDocuments | undefined;
		const third = await harness(home, {
			sourceScope: "private-session",
			onDocuments: (d) => {
				restored = d;
			},
		});
		expect(restored?.scratchpad_diagram.diagram).toContain("Private");
		await third.tutor.close();
	});
	test("cloud gate rejects before opening a model conversation", async () => {
		const home = await mkdtemp("/tmp/sidecar-cloudgate-");
		temporary.push(home);
		await expect(harness(home, { allowCloud: () => false })).rejects.toThrow(
			"local only",
		);
	});

	test("native abort cancels the active provider request", async () => {
		const home = await mkdtemp("/tmp/sidecar-abort-");
		temporary.push(home);
		const { tutor, faux } = await harness(home);
		let enteredResolve = () => {};
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		faux.setResponses([
			async (_context, options) => {
				enteredResolve();
				return new Promise<never>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				});
			},
		]);
		const outcome = tutor
			.converse("keep working until interrupted")
			.catch((error) => error);
		await entered;
		await tutor.abort?.();
		const error = await outcome;
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
		await tutor.close();
	}, 10000);
});
