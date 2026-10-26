import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Model, type Provider, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SessionEvent } from "../ingest/events.ts";
import { findRepoOkf, type OKFStore } from "../memory/okf-store.ts";
import type { TutorMode } from "../modes/modes.ts";
import { sidecarHome } from "../paths.ts";
import type { TutorDocuments } from "../protocol.ts";
import type { ToolSpec } from "../tool-spec.ts";
import {
	HudStateDoc,
	MermaidCanvasDoc,
	ResearchScratchpadDoc,
	SocraticQuizDoc,
	SteeringPromptDoc,
	TutorTraceDoc,
} from "./documents.ts";
import { loadPiRegistry, piCredential, TutorModelError } from "./provider.ts";
import { redact } from "./redact.ts";

const context = BACKGROUND_CONTEXT;
const ScopeDoc = defineDoc<{ ids: Record<string, number> }>({
	kind: "study.source_scopes",
	version: 1,
	scope: "session",
	initial: () => ({ ids: {} }),
});
const TUTOR_PROVIDER_ID = "sidecar";
const BASE_SYSTEM =
	"You are Sidecar Tutor, a senior architect and mentor. Explain what the coding agent is doing and why in concise 2-4 sentence educational answers. Use third person. Do not output full code replacements.";

export type TutorDocumentPatch = {
	[K in keyof Omit<TutorDocuments, "tutor_trace">]?: Partial<TutorDocuments[K]>;
};

/** The surface the engine drives; the durable harness is the only production implementation. */
export type TutorHarness = {
	converse(prompt: string): Promise<string>;
	updateDocuments(patch: TutorDocumentPatch): Promise<void>;
	close(): Promise<void>;
	abort?(): Promise<void>;
};

export type TutorHarnessOptions = {
	home: string;
	modelSlug: string;
	memory: OKFStore;
	mode: () => TutorMode;
	events: () => SessionEvent[];
	sessionCwd: () => string | undefined;
	sourceSession: () => string;
	/** Test seam: a prebuilt provider (e.g. pi-ai's faux provider) instead of the pi registry. */
	tutorProvider?: { provider: Provider; modelId: string };
	retryMaxRetries?: number;
	onDocuments?: (documents: TutorDocuments) => void;
	onReport?: (message: string) => void;
	/** Deep-lane tools contributed by daemon features (graph, learn, research). */
	extraTools?: () => ToolSpec[];
	allowCloud?: (path?: string) => boolean;
	allowExternalCloud?: (path?: string) => boolean;
	sourcePaths?: () => Promise<string[]>;
	sourceScope?: string;
};

const slug = (value: string) =>
	value
		.replace(/[^a-z0-9-]+/gi, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "scratch";

function mermaidLint(diagram: string): string[] {
	const problems: string[] = [];
	const text = diagram.trim();
	if (
		!/^(?:flowchart|graph|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram|mindmap|timeline|pie|gantt)\b/m.test(
			text,
		)
	)
		problems.push("no recognized diagram type on the first line");
	const opens = (text.match(/[[({]/g) ?? []).length;
	const closes = (text.match(/[\])}]/g) ?? []).length;
	if (opens !== closes)
		problems.push(`unbalanced brackets: ${opens} open vs ${closes} close`);
	if (/```/.test(text)) problems.push("nested code fence inside the diagram");
	return problems;
}

async function skillsSection(home: string): Promise<string | undefined> {
	const bundled = resolve(import.meta.dir, "../../../../skills");
	const user = join(sidecarHome(home), "skills");
	const skills = new Map<string, string>();
	for (const directory of [bundled, user]) {
		let names: string[];
		try {
			names = (await readdir(directory)).filter(
				(name) => !name.startsWith("."),
			);
		} catch {
			continue;
		}
		for (const name of names.slice(0, 8)) {
			try {
				const text = await readFile(join(directory, name, "SKILL.md"), "utf8");
				skills.set(name, text.trim().slice(0, 8_000));
			} catch {}
		}
	}
	if (!skills.size) return undefined;
	return [...skills]
		.map(([name, text]) => `### Skill: ${name}\n${text}`)
		.join("\n\n");
}

async function buildProvider(
	options: TutorHarnessOptions,
): Promise<{ provider: Provider; modelId: string }> {
	if (options.tutorProvider) return options.tutorProvider;
	const entry = (await loadPiRegistry(options.home)).get(options.modelSlug);
	if (!entry)
		throw new TutorModelError(
			`Pi model ${options.modelSlug} is unavailable; register it in ~/.pi/agent/models-store.json.`,
		);
	const key = await piCredential(options.home, entry.provider);
	const model: Model<"openai-completions"> = {
		id: entry.modelId,
		name: options.modelSlug,
		api: "openai-completions",
		provider: TUTOR_PROVIDER_ID,
		baseUrl: entry.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	return {
		modelId: model.id,
		provider: createProvider({
			id: TUTOR_PROVIDER_ID,
			name: "Sidecar tutor models",
			baseUrl: entry.baseUrl,
			auth: {
				apiKey: {
					name: `Pi ${entry.provider} key`,
					resolve: async () => ({
						auth: { apiKey: key },
						source: "~/.pi/agent/auth.json",
					}),
				},
			},
			models: [model],
			api: openAICompletionsApi(),
		}),
	};
}

/** Open the tutor's own durable harness: storage, tools, sections, compaction. */
export async function openTutorHarness(
	options: TutorHarnessOptions,
): Promise<TutorHarness> {
	const root = sidecarHome(options.home);
	const workspace = join(root, "workspace");
	const scratch = join(workspace, "scratch");
	for (const path of [root, workspace, scratch]) {
		await mkdir(path, { recursive: true, mode: 0o700 });
		if ((await lstat(path)).isSymbolicLink())
			throw new Error(`tutor-owned path cannot be a symlink: ${path}`);
		await chmod(path, 0o700);
	}
	const { provider, modelId } = await buildProvider(options);
	const models = createModels();
	models.setProvider(provider);

	const memory = options.memory;
	const watchedFile = async (requested: string): Promise<string> => {
		const cwd = options.sessionCwd();
		if (!cwd) throw new Error("no watched repository is attached");
		const repo = await realpath(cwd);
		const path = await realpath(resolve(repo, requested));
		const prefix = repo.endsWith(sep) ? repo : `${repo}${sep}`;
		if (!path.startsWith(prefix))
			throw new Error("requested file is outside the watched repository");
		if (options.allowCloud?.(path) === false)
			throw new Error("Source is local only");
		const file = await open(path, "r");
		try {
			const info = await file.stat();
			if (!info.isFile()) throw new Error("requested path is not a file");
			const bytes = new Uint8Array(Math.min(info.size, 64 * 1024));
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const suffix =
				info.size > bytesRead ? "\n[truncated at 65536 bytes]" : "";
			return new TextDecoder().decode(bytes.subarray(0, bytesRead)) + suffix;
		} finally {
			await file.close();
		}
	};
	const queryNotebookLm = async (query: string): Promise<string> => {
		if (
			(options.allowExternalCloud ?? options.allowCloud)?.() === false ||
			((await options.sourcePaths?.()) ?? []).some(
				(path) =>
					(options.allowExternalCloud ?? options.allowCloud)?.(path) === false,
			)
		)
			throw new Error("NotebookLM is unavailable for local-only sources");
		query = redact(query);
		const command = Bun.which("notebooklm");
		if (!command)
			throw new Error(
				"notebooklm CLI is unavailable; install teng-lin/notebooklm-py",
			);
		const notebookHome = join(root, "notebooklm");
		await mkdir(notebookHome, { recursive: true, mode: 0o700 });
		const process = Bun.spawn(
			[command, "--quiet", "ask", query, "--json", "--request-timeout", "30"],
			{
				cwd: workspace,
				env: { ...Bun.env, NOTEBOOKLM_HOME: notebookHome },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if (exitCode !== 0)
			throw new Error(stderr.trim() || `notebooklm exited ${exitCode}`);
		return stdout.trim();
	};
	let updateDocuments: (patch: TutorDocumentPatch) => Promise<void> =
		async () => {
			throw new Error("tutor conversation is not ready");
		};
	let recordTool: (
		label: string,
		detail: string,
		status?: "running" | "ok" | "error",
	) => Promise<void> = async () => {};
	const tools = defineExtension({
		name: "sidecar-tutor",
		sections: [
			section("preamble", () => BASE_SYSTEM, { tag: false }),
			section("study-mode", () => {
				const mode = options.mode();
				return `### Active Study Mode: ${mode.title}\n${mode.prompt}`;
			}),
			section("session-context", async () => {
				if (options.allowCloud?.() === false) return "Source is local only.";
				const events = options
					.events()
					.filter(
						(event) =>
							options.allowCloud?.(event.session_file) !== false &&
							(!event.file_path ||
								options.allowCloud?.(event.file_path) !== false),
					)
					.slice(-10);
				const lines = events.map(
					(event) =>
						`- ${event.headline}: ${redact(event.details.slice(0, 400))}`,
				);
				const query = events
					.slice(-3)
					.map((event) => `${event.headline} ${event.details}`)
					.join(" ")
					.slice(0, 300);
				const repo = await findRepoOkf(options.sessionCwd());
				const cards = query
					? await memory.query(query, repo, options.allowCloud)
					: [];
				if (cards.length)
					lines.push(
						"### Existing Concept Notes",
						...cards.map(
							(card) => `- ${card.bundle}: ${card.title}: ${card.preview}`,
						),
					);
				return redact(lines.join("\n")) || "No active coding session attached.";
			}),
			section("skills", () => skillsSection(options.home)),
		],
		tools: [
			defineTool({
				name: "read_watched_repo_file",
				description:
					"Read one text file under the attached repository without opening its session storage or writing to the repository",
				parameters: Type.Object({ path: Type.String() }),
				replay: "safe",
				execute: async (args) => {
					const path = String(args.path);
					const text = await watchedFile(path);
					await recordTool("Read watched repository", path);
					return { output: [{ type: "text", text: redact(text) }] };
				},
			}),
			defineTool({
				name: "search_okf_memory",
				description:
					"Search OKF concept bundles, or query the active NotebookLM notebook when notebooklm is true",
				parameters: Type.Object({
					query: Type.String(),
					notebooklm: Type.Optional(Type.Boolean()),
				}),
				execute: async (args) => {
					const query = String(args.query);
					if (args.notebooklm) {
						const answer = await queryNotebookLm(query);
						await recordTool("Queried NotebookLM", query);
						return { output: [{ type: "text", text: redact(answer) }] };
					}
					const repo = await findRepoOkf(options.sessionCwd());
					const hits = await memory.query(query, repo, options.allowCloud);
					await recordTool("Searched OKF memory", query);
					return {
						output: [
							{
								type: "text",
								text: hits.length
									? hits
											.map((hit) =>
												redact(`- ${hit.bundle}: ${hit.title}: ${hit.preview}`),
											)
											.join("\n")
									: "no matching concept cards",
							},
						],
					};
				},
			}),
			defineTool({
				name: "save_okf_concept_card",
				description:
					"Create or update an OKF v0.2 concept card in the learner bundle",
				parameters: Type.Object({
					title: Type.String(),
					body: Type.String(),
					topics: Type.Optional(Type.Array(Type.String())),
					mermaid: Type.Optional(Type.String()),
				}),
				execute: async (args) => {
					const title = String(args.title);
					const path = await memory.saveConcept(
						title,
						String(args.body),
						Array.isArray(args.topics) ? args.topics.map(String) : undefined,
						options.sourceSession(),
						typeof args.mermaid === "string" ? args.mermaid : undefined,
						undefined,
						await options.sourcePaths?.(),
					);
					await recordTool("Saved OKF concept", title);
					return { output: [{ type: "text", text: `saved ${path}` }] };
				},
			}),
			defineTool({
				name: "write_study_scratchpad",
				description:
					"Write a throwaway research note under the tutor-owned workspace/scratch directory",
				parameters: Type.Object({
					name: Type.String(),
					content: Type.String(),
				}),
				execute: async (args) => {
					const name = String(args.name);
					const content = String(args.content);
					const path = resolve(
						scratch,
						`${slug(name.replace(/\.(?:md|mmd)$/i, ""))}.md`,
					);
					await writeFile(path, content, { mode: 0o600 });
					await chmod(path, 0o600);
					await updateDocuments({
						research_scratchpad: { name, content: content.slice(0, 20_000) },
					});
					await recordTool("Wrote study scratchpad", name);
					return { output: [{ type: "text", text: path }] };
				},
			}),
			defineTool({
				name: "update_mermaid_canvas",
				description:
					"Validate and replace the live Mermaid canvas in durable state and the tutor scratch workspace",
				parameters: Type.Object({ diagram: Type.String() }),
				execute: async (args) => {
					const diagram = String(args.diagram).trim();
					const problems = mermaidLint(diagram);
					if (problems.length)
						throw new Error(`invalid Mermaid: ${problems.join("; ")}`);
					const path = join(scratch, "current-canvas.mmd");
					await writeFile(path, `${diagram}\n`, { mode: 0o600 });
					await updateDocuments({ scratchpad_diagram: { diagram } });
					await chmod(path, 0o600);
					await recordTool("Updated Mermaid canvas", path);
					return { output: [{ type: "text", text: `updated ${path}` }] };
				},
			}),
			defineTool({
				name: "emit_hud_artifacts",
				description:
					"Commit a HUD status, steering prompt, or Socratic quiz to the durable Tutor conversation",
				parameters: Type.Object({
					status: Type.Optional(Type.String()),
					message: Type.Optional(Type.String()),
					steering_prompt: Type.Optional(Type.String()),
					quiz: Type.Optional(
						Type.Object({
							question: Type.String(),
							options: Type.Array(
								Type.Object({ id: Type.String(), label: Type.String() }),
							),
							correctId: Type.Optional(Type.String()),
						}),
					),
				}),
				execute: async (args) => {
					const patch: TutorDocumentPatch = {};
					if (typeof args.status === "string") {
						if (
							!["idle", "thinking", "speaking", "error"].includes(args.status)
						)
							throw new Error("invalid HUD status");
						patch.hud_state = {
							status: args.status as TutorDocuments["hud_state"]["status"],
							...(typeof args.message === "string"
								? { message: args.message }
								: {}),
						};
					} else if (typeof args.message === "string")
						patch.hud_state = { message: args.message };
					if (typeof args.steering_prompt === "string")
						patch.steering_prompt = { prompt: args.steering_prompt };
					if (args.quiz)
						patch.socratic_quiz = {
							question: String(args.quiz.question),
							options: args.quiz.options.map((option) => ({
								id: String(option.id),
								label: String(option.label),
							})),
							...(typeof args.quiz.correctId === "string"
								? { correctId: args.quiz.correctId }
								: {}),
						};
					await updateDocuments(patch);
					await recordTool(
						"Updated HUD artifacts",
						Object.keys(patch).join(", "),
					);
					return {
						output: [{ type: "text", text: "HUD artifacts committed" }],
					};
				},
			}),
			...(options.extraTools?.() ?? []).map((spec) =>
				defineTool({
					name: spec.name,
					description: spec.description,
					parameters: spec.parameters,
					execute: async (args) => {
						const text = await spec.execute(args as Record<string, unknown>);
						await recordTool(spec.name, text.slice(0, 120));
						return { output: [{ type: "text", text: redact(text) }] };
					},
				}),
			),
		],
	});
	const registry = createRegistry();
	registry.install(tools);

	const storagePath = join(root, "tutor.sqlite");
	const harness = await Harness.open(
		await openNodeSqliteStorage(storagePath),
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
			settings: {
				compaction: {
					reserveTokens: 16_384,
					keepRecentTokens: 20_000,
					backgroundTokens: 32_768,
				},
				retry: { maxRetries: options.retryMaxRetries ?? 2 },
			},
			onReport: (error) =>
				options.onReport?.(
					error instanceof Error ? error.message : String(error),
				),
		},
		context,
	);
	await chmod(storagePath, 0o600).catch(() => undefined);
	harness.resume();
	const initOptions: NonNullable<Parameters<typeof harness.root>[1]> = {
		agent: { model: { provider: TUTOR_PROVIDER_ID, modelId } },
		init: async (tx, conversationId) => {
			const hud = await tx.doc(HudStateDoc, conversationId);
			hud.mode = options.mode().name;
			await tx.doc(MermaidCanvasDoc, conversationId);
			await tx.doc(SocraticQuizDoc, conversationId);
			await tx.doc(SteeringPromptDoc, conversationId);
			await tx.doc(ResearchScratchpadDoc, conversationId);
			await tx.doc(TutorTraceDoc, conversationId);
		},
	};
	const scopeKey = options.sourceScope
		? new Bun.CryptoHasher("sha256").update(options.sourceScope).digest("hex")
		: undefined;
	const storedId = scopeKey
		? await harness.commit(
				async (tx) => (await tx.doc(ScopeDoc)).ids[scopeKey],
				context,
			)
		: undefined;
	const existing = storedId
		? await harness.conversation(storedId as ConversationId, context)
		: undefined;
	const conversation =
		existing ??
		(scopeKey
			? await harness.createConversation(
					{ ownership: { kind: "ownerless" }, ...initOptions },
					context,
				)
			: await harness.root(context, initOptions));
	if (scopeKey && !existing)
		await harness.commit(async (tx) => {
			(await tx.doc(ScopeDoc)).ids[scopeKey] = conversation.id;
		}, context);
	// The root conversation persists its agent across restarts; re-point it at
	// the model this process selected, or generation settles no_model.
	const resolved = await conversation.agent(context);
	if (
		resolved.model?.provider !== TUTOR_PROVIDER_ID ||
		resolved.model?.modelId !== modelId
	)
		await conversation.configure(
			{ model: { provider: TUTOR_PROVIDER_ID, modelId } },
			context,
		);
	updateDocuments = async (patch) => {
		await conversation.commit(async (tx) => {
			if (patch.hud_state)
				Object.assign(
					await tx.doc(HudStateDoc, conversation.id),
					patch.hud_state,
				);
			if (patch.scratchpad_diagram)
				Object.assign(
					await tx.doc(MermaidCanvasDoc, conversation.id),
					patch.scratchpad_diagram,
				);
			if (patch.socratic_quiz) {
				const quiz = await tx.doc(SocraticQuizDoc, conversation.id);
				Object.assign(quiz, patch.socratic_quiz);
				if (
					"correctId" in patch.socratic_quiz &&
					patch.socratic_quiz.correctId === undefined
				)
					delete quiz.correctId;
			}
			if (patch.steering_prompt)
				Object.assign(
					await tx.doc(SteeringPromptDoc, conversation.id),
					patch.steering_prompt,
				);
			if (patch.research_scratchpad)
				Object.assign(
					await tx.doc(ResearchScratchpadDoc, conversation.id),
					patch.research_scratchpad,
				);
		}, context);
	};
	recordTool = async (label, detail, status = "ok") => {
		await conversation.commit(async (tx) => {
			const trace = await tx.doc(TutorTraceDoc, conversation.id);
			trace.items = [...trace.items, { label, detail, status }].slice(-20);
		}, context);
	};
	await conversation.commit(async (tx) => {
		const hud = await tx.doc(HudStateDoc, conversation.id);
		hud.mode = options.mode().name;
		await tx.doc(MermaidCanvasDoc, conversation.id);
		await tx.doc(SocraticQuizDoc, conversation.id);
		await tx.doc(SteeringPromptDoc, conversation.id);
		await tx.doc(ResearchScratchpadDoc, conversation.id);
		await tx.doc(TutorTraceDoc, conversation.id);
	}, context);
	const view = await conversation.viewState(context);
	const hudState = await harness.documentState(
		HudStateDoc,
		conversation.id,
		context,
	);
	const diagramState = await harness.documentState(
		MermaidCanvasDoc,
		conversation.id,
		context,
	);
	const quizState = await harness.documentState(
		SocraticQuizDoc,
		conversation.id,
		context,
	);
	const promptState = await harness.documentState(
		SteeringPromptDoc,
		conversation.id,
		context,
	);
	const scratchpadState = await harness.documentState(
		ResearchScratchpadDoc,
		conversation.id,
		context,
	);
	const traceState = await harness.documentState(
		TutorTraceDoc,
		conversation.id,
		context,
	);
	if (
		!hudState?.value ||
		!diagramState?.value ||
		!quizState?.value ||
		!promptState?.value ||
		!scratchpadState?.value ||
		!traceState?.value
	)
		throw new Error("tutor durable documents were not initialized");
	const current: TutorDocuments = {
		hud_state: { ...hudState.value },
		scratchpad_diagram: { ...diagramState.value },
		socratic_quiz: {
			...quizState.value,
			options: quizState.value.options.map((option) => ({ ...option })),
		},
		steering_prompt: { ...promptState.value },
		research_scratchpad: { ...scratchpadState.value },
		tutor_trace: traceState.value.items.map((item) => ({ ...item })),
	};
	const publish = () => options.onDocuments?.(structuredClone(current));
	const unsubscribers = [
		view.subscribe(publish),
		hudState.subscribe((value) => {
			if (value) current.hud_state = { ...value };
			publish();
		}),
		diagramState.subscribe((value) => {
			if (value) current.scratchpad_diagram = { ...value };
			publish();
		}),
		quizState.subscribe((value) => {
			if (value)
				current.socratic_quiz = {
					...value,
					options: value.options.map((option) => ({ ...option })),
				};
			publish();
		}),
		promptState.subscribe((value) => {
			if (value) current.steering_prompt = { ...value };
			publish();
		}),
		scratchpadState.subscribe((value) => {
			if (value) current.research_scratchpad = { ...value };
			publish();
		}),
		traceState.subscribe((value) => {
			if (value) current.tutor_trace = value.items.map((item) => ({ ...item }));
			publish();
		}),
	];
	publish();

	return {
		abort: () => conversation.abort(context),
		async converse(prompt: string): Promise<string> {
			if (options.allowCloud?.() === false)
				throw new Error("Source is local only");
			const settled = await (
				await conversation.submit(
					{ type: "input", content: redact(prompt) },
					context,
				)
			).wait(context);
			if (settled.status !== "done" || settled.type !== "input")
				throw new Error(
					`tutor conversation unanswered (${settled.status === "unanswered" ? settled.reason : settled.status})`,
				);
			const entry = await conversation.commit(
				(tx) => tx.entry(AssistantEntry, settled.answer),
				context,
			);
			const message = entry?.model?.[0];
			const content = message?.content;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("");
			if (!text.trim()) throw new Error("tutor model returned an empty answer");
			return text;
		},
		updateDocuments,
		async close(): Promise<void> {
			for (const unsubscribe of unsubscribers) unsubscribe();
			view.dispose();
			hudState.dispose();
			diagramState.dispose();
			quizState.dispose();
			promptState.dispose();
			scratchpadState.dispose();
			traceState.dispose();
			await harness.close(context);
		},
	};
}
