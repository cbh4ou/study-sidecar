import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writePrivateFile } from "../paths.ts";
import type { Clock } from "../ports/clock.ts";
import type {
	Lesson,
	LessonDetail,
	LessonMessage,
	LessonPhase,
	Question,
	SourceRef,
} from "../protocol.ts";
import { LessonRecordSchema } from "./contracts.ts";
import { derivePlanStatuses, planInit } from "./plan.ts";

export const MAX_ANCHORS = 8;
export const MAX_SOURCES = 24;
export const MAX_GOAL = 500;
const TITLE_MAX = 80;

export type LessonAnswer = {
	value: string;
	correct?: boolean;
	verdict?: string;
};

/** On-disk shape of `lessons/<id>.json`. */
export type LessonRecord = Lesson & {
	messages: LessonMessage[];
	questions: Question[];
	answers: Record<string, LessonAnswer>;
	queuedGaps: string[];
	sources: SourceRef[];
};

const ID = /^les_[a-z0-9_]+$/;

export function derivePhase(record: {
	measure?: unknown;
	planMermaid?: string;
}): LessonPhase {
	if (record.measure === undefined) return "measure";
	if (!record.planMermaid) return "plan";
	return "teach";
}

export function defaultTitle(goal: string): string {
	const clean = goal.replace(/\s+/g, " ").trim();
	if (clean.length <= TITLE_MAX) return clean;
	const cut = clean.slice(0, TITLE_MAX - 3);
	const space = cut.lastIndexOf(" ");
	return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export function toLesson(record: LessonRecord): Lesson {
	const {
		messages: _m,
		questions: _q,
		answers: _a,
		queuedGaps: _g,
		sources: _s,
		...lesson
	} = record;
	return { ...lesson, phase: derivePhase(record) };
}

export function toDetail(record: LessonRecord): LessonDetail {
	let planNodes: LessonDetail["planNodes"] = [];
	if (record.planMermaid) {
		const plan = planInit(record.planMermaid);
		if (plan.ok) {
			const tagged = record.questions.flatMap((question) =>
				question.kind === "quiz" && question.planNode
					? [
							{
								planNode: question.planNode,
								correct: record.answers[question.id]?.correct,
							},
						]
					: [],
			);
			planNodes = derivePlanStatuses(plan.nodes, plan.edges, tagged);
		}
	}
	return {
		...toLesson(record),
		messages: record.messages,
		questions: record.questions,
		answers: record.answers,
		planNodes,
		queuedGaps: record.queuedGaps,
		sources: record.sources,
	};
}

function normalize(raw: unknown): LessonRecord | undefined {
	const parsed = LessonRecordSchema.safeParse(raw);
	if (!parsed.success) return undefined;
	return { ...parsed.data, phase: derivePhase(parsed.data) };
}

let seq = 0;

/**
 * Sole writer of `<root>/lessons/*.json`. Every mutation is a
 * read-modify-write through `update`, serialized per lesson and written
 * atomically.
 */
export class LessonStore {
	readonly dir: string;
	#locks = new Map<string, Promise<unknown>>();
	constructor(
		root: string,
		private readonly clock: Clock,
	) {
		this.dir = join(root, "lessons");
	}

	#path(id: string): string {
		if (!ID.test(id)) throw new Error(`invalid lesson id ${id}`);
		return join(this.dir, `${id}.json`);
	}

	#iso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	newId(prefix: string): string {
		seq = (seq + 1) % 1_000_000;
		return `${prefix}_${this.clock.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	async get(id: string): Promise<LessonRecord | undefined> {
		if (!ID.test(id)) return undefined;
		const raw = await readJsonFile<Partial<LessonRecord> | null>(
			this.#path(id),
			null,
		);
		return raw ? normalize(raw) : undefined;
	}

	async list(): Promise<LessonRecord[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return [];
		}
		const records = await Promise.all(
			names
				.filter((name) => name.endsWith(".json"))
				.map((name) => this.get(name.slice(0, -5))),
		);
		return records
			.filter((record): record is LessonRecord => record !== undefined)
			.sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			);
	}

	async create(input: {
		goal: string;
		title?: string;
		anchors?: SourceRef[];
		sessionPath?: string;
	}): Promise<LessonRecord> {
		const at = this.#iso();
		const record: LessonRecord = {
			id: this.newId("les"),
			title: input.title?.trim() || defaultTitle(input.goal),
			goal: input.goal.trim(),
			anchors: (input.anchors ?? []).slice(0, MAX_ANCHORS),
			phase: "measure",
			...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
			createdAt: at,
			updatedAt: at,
			messages: [],
			questions: [],
			answers: {},
			queuedGaps: [],
			sources: [],
		};
		await this.#write(record);
		return record;
	}

	/** Serialized read-modify-write; `mutate` may throw to abort. */
	update(
		id: string,
		mutate: (record: LessonRecord) => void | Promise<void>,
	): Promise<LessonRecord> {
		const previous = this.#locks.get(id) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				const record = await this.get(id);
				if (!record) throw new Error(`unknown lesson ${id}`);
				await mutate(record);
				record.updatedAt = this.#iso();
				record.anchors = record.anchors.slice(0, MAX_ANCHORS);
				record.phase = derivePhase(record);
				await this.#write(record);
				return record;
			});
		this.#locks.set(id, next);
		void next
			.finally(() => {
				if (this.#locks.get(id) === next) this.#locks.delete(id);
			})
			.catch(() => undefined);
		return next;
	}

	async #write(record: LessonRecord): Promise<void> {
		LessonRecordSchema.parse(record);
		await writePrivateFile(
			this.#path(record.id),
			`${JSON.stringify(record, null, 2)}\n`,
		);
	}

	appendMessage(
		id: string,
		message: Omit<LessonMessage, "id" | "at">,
	): Promise<LessonRecord> {
		return this.update(id, (record) => {
			record.messages.push({
				id: this.newId("msg"),
				at: this.#iso(),
				...message,
			});
		});
	}
}
