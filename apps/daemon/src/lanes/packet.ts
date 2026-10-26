import type { Clock } from "../ports/clock.ts";
import type { Services } from "../services.ts";
import { redact } from "../tutor/redact.ts";
import { anchorSkeleton } from "./skeleton.ts";

/**
 * Context Packet builder (spec Section 8). Pure: same input, same bytes.
 * Section 1 is the byte-stable `system` prefix (prompt caching); sections
 * 2 to 7 form the `user` message. Every string passes through `redact()`.
 */

export const PACKET_CAP = 4000;

/** Fixed chars/4 estimator shared by the builder and its tests. */
export const estimateTokens = (text: string): number =>
	Math.ceil(text.length / 4);

export type SectionName =
	| "rules"
	| "learner"
	| "anchors"
	| "receipts"
	| "memory"
	| "lesson"
	| "question";

export const SECTION_BUDGETS: Record<
	Exclude<SectionName, "question">,
	number
> = {
	rules: 700,
	learner: 300,
	anchors: 900,
	receipts: 600,
	memory: 400,
	lesson: 300,
};

/** Overflow trim order: receipts, then memory, then anchors. */
export const TRIM_ORDER = ["receipts", "memory", "anchors"] as const;

export type PacketMode = { name: string; description: string; prompt: string };

export type PacketInput = {
	mode: PacketMode;
	/** `lanes/TUTOR.md` contents. */
	tutorRules: string;
	/** Proposition lines, most important first. */
	learner?: string[];
	/** Pinned anchors; reduced to skeletons. Most important first. */
	anchors?: Array<{ path: string; text: string }>;
	/** Tier-0 receipts, oldest first (newest last). */
	receipts?: string[];
	/** Memory hits, most relevant first. */
	memory?: string[];
	/** Lesson state lines (current plan node, last question). */
	lesson?: string[];
	question: string;
};

export type ContextPacket = {
	system: string;
	user: string;
	tokens: number;
	sections: Record<SectionName, { tokens: number; items: number }>;
};

type Section = {
	name: Exclude<SectionName, "rules">;
	title: string;
	items: string[];
	/** Which end holds the oldest / least important items. */
	dropFrom: "start" | "end";
};

const TITLES: Record<Exclude<SectionName, "rules">, string> = {
	learner: "Learner snapshot",
	anchors: "Pinned anchor skeleton",
	receipts: "Recent session receipts",
	memory: "Recalled memory",
	lesson: "Lesson state",
	question: "Question",
};

function truncate(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;
	const chars = Math.max(0, maxTokens * 4 - 1);
	return chars ? `${text.slice(0, chars)}…` : "";
}

function render(section: Section): string {
	if (!section.items.length) return "";
	const body =
		section.name === "question" || section.name === "anchors"
			? section.items.join("\n\n")
			: section.items.map((item) => `- ${item}`).join("\n");
	return `## ${section.title}\n${body}`;
}

/** Shrink a section by one step: drop its oldest item, or truncate the last. */
function shrink(section: Section, overflowTokens: number): boolean {
	if (!section.items.length) return false;
	if (section.items.length > 1) {
		if (section.dropFrom === "start") section.items.shift();
		else section.items.pop();
		return true;
	}
	const only = section.items[0] ?? "";
	const target = estimateTokens(only) - Math.max(1, overflowTokens);
	if (target < 8) section.items = [];
	else section.items = [truncate(only, target)];
	return true;
}

function fit(section: Section, budget: number): Section {
	while (estimateTokens(render(section)) > budget) {
		const over = estimateTokens(render(section)) - budget;
		if (!shrink(section, over)) break;
	}
	return section;
}

function clean(items: string[] | undefined): string[] {
	return (items ?? []).map((item) => redact(item).trim()).filter(Boolean);
}

/** Section 1: byte-stable for a given mode + TUTOR.md. */
export function buildSystem(mode: PacketMode, tutorRules: string): string {
	const parts = [
		tutorRules.trim(),
		`## Mode: ${mode.name}`,
		mode.description.trim(),
		mode.prompt.trim(),
	].filter(Boolean);
	return truncate(redact(parts.join("\n\n")), SECTION_BUDGETS.rules);
}

export function buildContextPacket(input: PacketInput): ContextPacket {
	const system = buildSystem(input.mode, input.tutorRules);
	const make = (
		name: Section["name"],
		items: string[],
		dropFrom: Section["dropFrom"] = "end",
	): Section => ({ name, title: TITLES[name], items, dropFrom });
	const sections: Record<Section["name"], Section> = {
		learner: fit(
			make("learner", clean(input.learner)),
			SECTION_BUDGETS.learner,
		),
		anchors: fit(
			make(
				"anchors",
				clean(
					(input.anchors ?? []).map((anchor) =>
						anchorSkeleton(anchor.text, anchor.path),
					),
				),
			),
			SECTION_BUDGETS.anchors,
		),
		receipts: fit(
			make("receipts", clean(input.receipts), "start"),
			SECTION_BUDGETS.receipts,
		),
		memory: fit(make("memory", clean(input.memory)), SECTION_BUDGETS.memory),
		lesson: fit(make("lesson", clean(input.lesson)), SECTION_BUDGETS.lesson),
		question: make("question", clean([input.question])),
	};
	const order: Section["name"][] = [
		"learner",
		"anchors",
		"receipts",
		"memory",
		"lesson",
		"question",
	];
	const user = () =>
		order
			.map((name) => render(sections[name]))
			.filter(Boolean)
			.join("\n\n");
	const total = () => estimateTokens(system) + estimateTokens(user());

	// Overflow: trim receipts, then memory, then anchors; the question last.
	for (const name of TRIM_ORDER)
		while (
			total() > PACKET_CAP &&
			shrink(sections[name], total() - PACKET_CAP)
		);
	while (
		total() > PACKET_CAP &&
		shrink(sections.question, total() - PACKET_CAP)
	);

	const finalUser = user();
	const counts = Object.fromEntries(
		order.map((name) => [
			name,
			{
				tokens: estimateTokens(render(sections[name])),
				items: sections[name].items.length,
			},
		]),
	) as Record<Section["name"], { tokens: number; items: number }>;
	return {
		system,
		user: finalUser,
		tokens: estimateTokens(system) + estimateTokens(finalUser),
		sections: {
			rules: { tokens: estimateTokens(system), items: system ? 1 : 0 },
			...counts,
		},
	};
}

/* ---- Warm packet: rebuilt on session events so PTT finds it ready ---- */

export type PacketBase = {
	learner: string[];
	anchors: Array<{ path: string; text: string }>;
	receipts: string[];
	lesson: string[];
	lessonId?: string;
};

export type RecallFn = (question: string) => Promise<string[]> | string[];

export type PacketWarmerOptions = {
	services: Services;
	clock: Clock;
	mode: () => PacketMode;
	tutorRules: string;
	recall?: RecallFn;
	/** Read an anchor file (read-only). Defaults to Bun.file. */
	readFile?: (path: string) => Promise<string>;
	debounceMs?: number;
	/** Called after each background rebuild (tests). */
	onWarm?: (base: PacketBase) => void;
};

export type BuildOptions = {
	lessonId?: string;
	/** Widen receipts to every non-local_only session. */
	allSessions?: boolean;
	/** Drop bound-session text (local_only source + cloud fast lane). */
	excludeSession?: boolean;
};

const MAX_ANCHORS = 3;

export class PacketWarmer {
	#base?: PacketBase;
	#timer: unknown;
	#warming?: Promise<PacketBase>;
	constructor(private readonly options: PacketWarmerOptions) {}

	/** Debounced rebuild (session events, PTT press). */
	schedule(): void {
		const { clock } = this.options;
		if (this.#timer !== undefined) clock.clearTimeout(this.#timer);
		this.#timer = clock.setTimeout(() => {
			this.#timer = undefined;
			void this.warm().then(
				(base) => this.options.onWarm?.(base),
				() => undefined,
			);
		}, this.options.debounceMs ?? 250);
	}

	cancel(): void {
		if (this.#timer !== undefined) this.options.clock.clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	get base(): PacketBase | undefined {
		return this.#base;
	}

	/** Rebuild the non-question part now. */
	warm(lessonId?: string): Promise<PacketBase> {
		const run = this.#collect(lessonId).then((base) => {
			this.#base = base;
			return base;
		});
		this.#warming = run;
		return run.finally(() => {
			if (this.#warming === run) this.#warming = undefined;
		});
	}

	async build(
		question: string,
		opts: BuildOptions = {},
	): Promise<ContextPacket> {
		const { services } = this.options;
		const lessonId = opts.lessonId ?? services.learn?.activeLessonId();
		let base = this.#warming
			? await this.#warming.catch(() => undefined)
			: this.#base;
		if (!base || base.lessonId !== lessonId) base = await this.warm(lessonId);
		let receipts = base.receipts;
		if (opts.allSessions)
			receipts =
				services.sessions
					?.searchAcross(question, 12)
					.map((hit) => `${hit.path}: ${hit.receipt}`)
					.reverse() ?? [];
		else if (opts.excludeSession) receipts = [];
		let memory: string[] = [];
		try {
			memory = ((await this.options.recall?.(question)) ?? []).slice(0, 5);
		} catch {
			memory = [];
		}
		return buildContextPacket({
			mode: this.options.mode(),
			tutorRules: this.options.tutorRules,
			learner: base.learner,
			anchors: opts.excludeSession ? [] : base.anchors,
			receipts,
			memory,
			lesson: base.lesson,
			question,
		});
	}

	async #collect(lessonId?: string): Promise<PacketBase> {
		const { services } = this.options;
		const id = lessonId ?? services.learn?.activeLessonId();
		const [recent, due, lesson] = await Promise.all([
			services.graph?.recent(8).catch(() => []) ?? [],
			services.learn?.dueCards().catch(() => []) ?? [],
			id
				? (services.learn?.lesson(id).catch(() => undefined) ?? undefined)
				: undefined,
		]);
		const learner = [
			...recent.map((p) => `${p.name}: ${p.statement}`),
			...due.slice(0, 4).map((card) => `Due for review: ${card.question}`),
		];
		const lessonLines: string[] = [];
		const anchors: Array<{ path: string; text: string }> = [];
		if (lesson) {
			lessonLines.push(`Lesson: ${lesson.title} (goal: ${lesson.goal})`);
			const current = lesson.planNodes.find(
				(node) => node.status === "current",
			);
			if (current) lessonLines.push(`Current plan node: ${current.label}`);
			const last = lesson.questions.at(-1);
			if (last) lessonLines.push(`Last question: ${last.prompt}`);
			const read =
				this.options.readFile ?? ((path: string) => Bun.file(path).text());
			for (const anchor of lesson.anchors) {
				if (anchors.length >= MAX_ANCHORS) break;
				if (anchor.kind !== "file") continue;
				try {
					anchors.push({ path: anchor.path, text: await read(anchor.path) });
				} catch {
					/* unreadable anchor: skip */
				}
			}
		}
		const receipts = services.sessions?.receipts(undefined, 12) ?? [];
		return {
			learner,
			anchors,
			receipts,
			lesson: lessonLines,
			...(id ? { lessonId: id } : {}),
		};
	}
}
