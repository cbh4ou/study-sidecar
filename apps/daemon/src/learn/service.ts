import { join } from "node:path";
import type { ActivityRegistry } from "../activity.ts";
import { SourceRefSchema } from "../graph/contracts.ts";
import { appendJsonLine, readJsonLines } from "../paths.ts";
import type { Clock } from "../ports/clock.ts";
import type { DecidePort } from "../ports/decide.ts";
import { DECIDE_OPTIONS } from "../ports/decide.ts";
import type { LlmPort } from "../ports/llm.ts";
import type {
	Card,
	ClientMessage,
	DaemonMessage,
	LessonDetail,
	MeasureLevel,
	Question,
	ReviewRating,
	SourceRef,
} from "../protocol.ts";
import type { LearnService, Services } from "../services.ts";
import { redact } from "../tutor/redact.ts";
import { CardStore } from "./cards.ts";
import {
	ConceptNoteSchema,
	CreateLessonSchema,
	MeasureSchema,
	QuestionSchema,
} from "./contracts.ts";
import {
	type LessonRecord,
	LessonStore,
	MAX_ANCHORS,
	MAX_GOAL,
	MAX_SOURCES,
	toDetail,
	toLesson,
} from "./lessons.ts";
import { planInit } from "./plan.ts";
import { gradeAnswer, verdictPassed, verdictToRating } from "./questions.ts";
import {
	type ConceptNote,
	heuristicCandidates,
	llmCandidates,
	recapPrompt,
	resolvePropositionId,
} from "./recap.ts";

/** The slice of DaemonContext the learn service needs (tests fake this). */
export type LearnDeps = {
	root: string;
	fake: boolean;
	broadcast(message: DaemonMessage): void;
	ports: { decide: DecidePort; llm: LlmPort; clock: Clock };
	services: Services;
	activity: ActivityRegistry;
	dispatch?(message: ClientMessage): Promise<boolean>;
};

export type AskQuestionInput =
	| {
			kind: "quiz";
			prompt: string;
			options: Array<{ id: string; label: string }>;
			correctId: string;
			planNode?: string;
	  }
	| { kind: "ask"; prompt: string }
	| { kind: "explain_back"; prompt: string; expectedPropositions: string[] };

const isNote = (value: unknown): value is ConceptNote =>
	ConceptNoteSchema.safeParse(value).success;

export function parseSourceRef(value: unknown): SourceRef {
	const parsed = SourceRefSchema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			`invalid source: ${parsed.error.issues[0]?.message ?? "bad shape"}`,
		);
	return parsed.data as SourceRef;
}

/**
 * LearnService implementation: lessons, questions, cards and recap. Sole
 * writer of `lessons/`, `cards/` and `notes.jsonl`. Broadcasts
 * `lessons_changed`, `question` and `cards_due` on mutation.
 */
export class Learn implements LearnService {
	readonly lessons: LessonStore;
	readonly cards: CardStore;
	readonly notesPath: string;
	#active: string | undefined;
	#lastRecapAt = 0;
	#recapRunning: Promise<Card[]> | undefined;

	constructor(private readonly deps: LearnDeps) {
		this.lessons = new LessonStore(deps.root, deps.ports.clock);
		this.cards = new CardStore(deps.root, deps.ports.clock);
		this.notesPath = join(deps.root, "notes.jsonl");
	}

	get #clock(): Clock {
		return this.deps.ports.clock;
	}

	#sourceLocalOnly(ref: SourceRef): boolean {
		const path =
			ref.kind === "session"
				? (ref.file ?? ref.sessionId)
				: ref.kind === "lesson"
					? ref.lessonId
					: ref.kind === "web"
						? ref.url
						: ref.path;
		return this.deps.services.privacy?.isLocalOnly(path) ?? false;
	}
	#localOnly(record?: LessonRecord): boolean {
		const privacy = this.deps.services.privacy;
		return !!(
			privacy?.isLocalOnly(
				record?.sessionPath ?? this.deps.services.sessions?.bound()?.path,
			) ||
			privacy?.isLocalOnly(record?.id) ||
			[...(record?.anchors ?? []), ...(record?.sources ?? [])].some((ref) =>
				this.#sourceLocalOnly(ref),
			)
		);
	}
	#provenance(record: LessonRecord): SourceRef[] {
		return [
			...record.anchors,
			...record.sources,
			...(record.sessionPath
				? [
						{
							kind: "session" as const,
							harness: "auto",
							sessionId: record.sessionPath,
							file: record.sessionPath,
						},
					]
				: []),
		];
	}
	#extract(record: LessonRecord, flush = false): void {
		this.deps.services.graph?.noteProse(
			{
				id: record.id,
				label: record.title,
				localOnly: this.#localOnly(record),
				refs: this.#provenance(record),
			},
			record.messages
				.filter((m) => m.role === "tutor" && !m.id.startsWith("recap_"))
				.map(({ id, text }) => ({ id, text })),
			{ flush },
		);
	}

	#changed(): void {
		this.deps.broadcast({ type: "lessons_changed" });
	}

	async broadcastDue(): Promise<number> {
		const count = (await this.cards.due()).length;
		this.deps.broadcast({ type: "cards_due", count });
		return count;
	}

	/* ---- lessons ---- */

	activeLessonId(): string | undefined {
		return this.#active;
	}

	setActiveLesson(id: string | undefined): void {
		this.#active = id;
	}

	async listLessons() {
		return (await this.lessons.list()).map(toLesson);
	}

	async createLesson(input: {
		goal: string;
		title?: string;
		anchors?: SourceRef[];
		sessionPath?: string;
	}) {
		CreateLessonSchema.parse(input);
		const goal = input.goal.trim();
		if (!goal) throw new Error("goal is required");
		if (goal.length > MAX_GOAL)
			throw new Error(`goal must be at most ${MAX_GOAL} characters`);
		const record = await this.lessons.create({ ...input, goal });
		this.#active = record.id;
		this.#changed();
		return toLesson(record);
	}

	async lesson(id: string): Promise<LessonDetail | undefined> {
		const record = await this.lessons.get(id);
		return record ? toDetail(record) : undefined;
	}

	async appendMessage(
		lessonId: string,
		message: {
			role: "tutor" | "learner";
			kind: "text" | "think_aloud";
			text: string;
		},
	): Promise<void> {
		const record = await this.lessons.appendMessage(lessonId, message);
		if (message.role === "tutor") this.#extract(record);
		this.#changed();
	}

	async #mutate(
		lessonId: string,
		mutate: (record: LessonRecord) => void | Promise<void>,
	): Promise<LessonDetail> {
		const record = await this.lessons.update(lessonId, mutate);
		this.#changed();
		return toDetail(record);
	}

	addSource(lessonId: string, source: unknown): Promise<LessonDetail> {
		const ref = parseSourceRef(source);
		return this.#mutate(lessonId, (record) => {
			const key = JSON.stringify(ref);
			if (record.sources.some((existing) => JSON.stringify(existing) === key))
				return;
			if (record.sources.length >= MAX_SOURCES)
				throw new Error(`a lesson holds at most ${MAX_SOURCES} sources`);
			record.sources.push(ref);
		});
	}

	pinAnchor(lessonId: string, source: unknown): Promise<LessonDetail> {
		const ref = parseSourceRef(source);
		return this.#mutate(lessonId, (record) => {
			const key = JSON.stringify(ref);
			if (!record.anchors.some((anchor) => JSON.stringify(anchor) === key)) {
				if (record.anchors.length >= MAX_ANCHORS)
					throw new Error(
						`A lesson holds at most ${MAX_ANCHORS} pinned anchors`,
					);
				record.anchors.push(ref);
			}
			if (
				!record.sources.some((existing) => JSON.stringify(existing) === key) &&
				record.sources.length < MAX_SOURCES
			)
				record.sources.push(ref);
		});
	}

	setMeasure(
		lessonId: string,
		levels: Record<string, MeasureLevel>,
	): Promise<LessonDetail> {
		return this.#mutate(lessonId, (record) => {
			MeasureSchema.parse(levels);
			const probes = record.questions.filter((q) => record.answers[q.id]);
			if (probes.length < 3 || probes.length > 6)
				throw new Error(
					"Measure requires 3 to 6 answered probes before recording levels",
				);
			record.measure = { ...levels };
		});
	}

	/** Author-once plan; throws the line-numbered parse errors. */
	setPlan(lessonId: string, mermaid: string): Promise<LessonDetail> {
		const plan = planInit(mermaid);
		if (!plan.ok) throw new Error(plan.errors.join("\n"));
		return this.#mutate(lessonId, (record) => {
			if (!record.measure)
				throw new Error("Measure prerequisites before authoring a plan");
			if (record.planMermaid)
				throw new Error("this lesson already has a plan; it is authored once");
			record.planMermaid = mermaid.trim();
		});
	}

	queueGap(lessonId: string, topic: string): Promise<LessonDetail> {
		const clean = topic.trim();
		if (!clean) throw new Error("topic is required");
		return this.#mutate(lessonId, (record) => {
			if (!record.queuedGaps.includes(clean)) record.queuedGaps.push(clean);
		});
	}

	async askQuestion(
		lessonId: string,
		input: AskQuestionInput,
	): Promise<Question> {
		const id = this.lessons.newId("q");
		let question: Question;
		if (input.kind === "quiz") {
			if (input.options.length < 2)
				throw new Error("a quiz needs at least two options");
			if (!input.options.some((option) => option.id === input.correctId))
				throw new Error("correctId must match one of the option ids");
			question = {
				kind: "quiz",
				id,
				prompt: input.prompt,
				options: input.options,
				correctId: input.correctId,
				...(input.planNode ? { planNode: input.planNode } : {}),
			};
		} else if (input.kind === "explain_back") {
			if (input.expectedPropositions.length === 0)
				throw new Error("explain_back needs at least one expected proposition");
			question = {
				kind: "explain_back",
				id,
				prompt: input.prompt,
				expectedPropositions: input.expectedPropositions,
			};
		} else question = { kind: "ask", id, prompt: input.prompt };
		QuestionSchema.parse(question);
		await this.#mutate(lessonId, (record) => {
			if (!record.measure && record.questions.length >= 6)
				throw new Error(
					"Measure has six probes; record the results before continuing",
				);
			if (question.kind === "quiz" && question.planNode && record.planMermaid) {
				const plan = planInit(record.planMermaid);
				if (
					plan.ok &&
					!plan.nodes.some((node) => node.id === question.planNode)
				)
					throw new Error(`unknown plan node ${question.planNode}`);
			}
			record.questions.push(question);
		});
		this.deps.broadcast({ type: "question", lessonId, question });
		return question;
	}

	async answer(
		questionId: string,
		value: string,
	): Promise<{ correct?: boolean; verdict?: string } | undefined> {
		if (!value.trim()) throw new Error("answer is required");
		const lessons = await this.lessons.list();
		const record = lessons.find(
			(lesson) =>
				lesson.questions.some((question) => question.id === questionId) &&
				!lesson.answers[questionId],
		);
		const question = record?.questions.find((item) => item.id === questionId);
		if (!record || !question) return undefined;
		const expected =
			question.kind === "explain_back"
				? await Promise.all(
						question.expectedPropositions.map((id) =>
							this.deps.services.graph?.get(id),
						),
					)
				: [];
		const expectedLocal = expected.some(
			(node) =>
				node &&
				(this.deps.services.privacy?.isLocalOnly(node.birthSource) ||
					node.sources.some((ref) => this.#sourceLocalOnly(ref))),
		);
		const result = await gradeAnswer(question, value, {
			decide: this.deps.ports.decide,
			graph: this.deps.services.graph,
			localOnly: this.#localOnly(record) || expectedLocal,
		});
		let wroteAnswer = false;
		await this.#mutate(record.id, (fresh) => {
			if (fresh.answers[questionId]) return;
			wroteAnswer = true;
			fresh.messages.push({
				id: this.lessons.newId("msg"),
				at: new Date(this.#clock.now()).toISOString(),
				role: "learner",
				kind: "text",
				text: value,
			});
			fresh.answers[questionId] = {
				value,
				...(result.correct !== undefined ? { correct: result.correct } : {}),
				...(result.verdict ? { verdict: result.verdict } : {}),
			};
		});
		if (!wroteAnswer) return undefined;
		if (
			question.kind === "explain_back" &&
			result.verdict &&
			verdictPassed(result.verdict)
		) {
			const propositionId = question.expectedPropositions[0];
			if (
				propositionId &&
				(await this.deps.services.graph?.get(propositionId))
			) {
				const card = await this.cards.create({
					propositionId,
					question: question.prompt,
					source: {
						kind: "lesson",
						lessonId: record.id,
						messageId: record.messages.at(-1)?.id ?? questionId,
					},
				});
				await this.cards.review(
					card.id,
					verdictToRating(result.verdict),
					"explain_back",
					value,
				);
				await this.broadcastDue();
			}
		}
		return {
			...(result.correct !== undefined ? { correct: result.correct } : {}),
			...(result.verdict ? { verdict: result.verdict } : {}),
		};
	}

	async fakeTurn(lessonId: string): Promise<Question | undefined> {
		let record = await this.lessons.get(lessonId);
		if (!record) return;
		const answers = record.answers;
		const pending = record.questions.find((q) => !answers[q.id]);
		if (pending) {
			this.deps.broadcast({ type: "question", lessonId, question: pending });
			return pending;
		}
		if (!record.measure) {
			if (record.questions.length < 3) {
				const n = record.questions.length;
				if (n === 1)
					return this.askQuestion(lessonId, {
						kind: "quiz",
						prompt: "Which evidence shows that a consumer finished processing?",
						options: [
							{ id: "a", label: "The message was sent" },
							{ id: "b", label: "The consumer acknowledges after processing" },
						],
						correctId: "b",
					});
				return this.askQuestion(lessonId, {
					kind: "ask",
					prompt:
						n === 0
							? "What do you already know about this topic?"
							: "What prerequisite feels least familiar?",
				});
			}
			await this.setMeasure(lessonId, {
				foundations: "shaky",
				application: "new",
				reasoning: "new",
			});
			return;
		}
		if (!record.planMermaid) {
			await this.setPlan(
				lessonId,
				"flowchart TD\nA[Foundations] --> B[Application]\nB --> C[Explain the reasoning]",
			);
			return;
		}
		record = await this.lessons.get(lessonId);
		if (!record) return;
		const current = toDetail(record).planNodes.find(
			(n) => n.status === "current",
		);
		if (!current) {
			if (record.questions.some((q) => q.kind === "explain_back")) return;
			const [node] = (await this.deps.services.graph?.recent(1)) ?? [];
			if (node)
				return this.askQuestion(lessonId, {
					kind: "explain_back",
					prompt:
						"Explain why acknowledging after processing protects a message.",
					expectedPropositions: [node.id],
				});
			return;
		}
		return this.askQuestion(lessonId, {
			kind: "quiz",
			prompt: `Check ${current.label}: what does an acknowledgement establish?`,
			options: [
				{ id: "a", label: "The message was sent" },
				{ id: "b", label: "The consumer handled the message" },
			],
			correctId: "b",
			planNode: current.id,
		});
	}
	async gradeVoice(cardId: string, text: string): Promise<ReviewRating> {
		const card = await this.cards.get(cardId);
		if (!card) throw new Error("unknown card");
		const exact = text
			.trim()
			.toLowerCase()
			.replace(/[.!?]+$/, "");
		let rating: ReviewRating;
		if (["again", "hard", "good", "easy"].includes(exact))
			rating = exact as ReviewRating;
		else {
			const node = await this.deps.services.graph?.get(card.propositionId);
			const localOnly =
				this.#sourceLocalOnly(card.source) ||
				!!(
					node &&
					(this.deps.services.privacy?.isLocalOnly(node.birthSource) ||
						node.sources.some((ref) => this.#sourceLocalOnly(ref)))
				);
			const verdict = await this.deps.ports.decide.decide(
				"explain_back",
				redact(
					`Prompt: ${card.question}\nLearner: ${text}\nExpected: ${node?.statement ?? card.propositionId}`,
				),
				DECIDE_OPTIONS.explain_back,
				{ localOnly },
			);
			rating = verdictToRating(verdict.choice);
		}
		await this.grade(cardId, rating, "voice", text);
		return rating;
	}

	/* ---- cards ---- */

	dueCards(now?: number): Promise<Card[]> {
		return this.cards.due(now);
	}

	async createCard(input: {
		propositionId: string;
		question: string;
		example?: string;
		source: SourceRef;
	}): Promise<Card> {
		if (
			this.deps.services.graph &&
			!(await this.deps.services.graph.get(input.propositionId))
		)
			throw new Error(`unknown proposition ${input.propositionId}`);
		const node = await this.deps.services.graph?.get(input.propositionId);
		const cited = node?.sources.find(
			(ref) => ref.kind === "web" || ref.kind === "pdf",
		);
		const card = await this.cards.create({
			...input,
			source: cited ?? input.source,
		});
		await this.broadcastDue();
		return card;
	}

	async grade(
		cardId: string,
		rating: ReviewRating,
		by: "button" | "voice" | "explain_back",
		answerText?: string,
	): Promise<void> {
		await this.cards.review(cardId, rating, by, answerText);
		await this.broadcastDue();
	}

	/* ---- notes + recap ---- */

	async noteConcept(input: {
		concept: string;
		why?: string;
		source?: SourceRef;
	}): Promise<void> {
		const concept = input.concept.trim().slice(0, 200);
		if (!concept) return;
		const note: ConceptNote = {
			concept,
			...(input.why ? { why: input.why.slice(0, 500) } : {}),
			source: input.source
				? parseSourceRef(input.source)
				: sessionSource(this.deps.services),
			at: new Date(this.#clock.now()).toISOString(),
		};
		ConceptNoteSchema.parse(note);
		await appendJsonLine(this.notesPath, note);
	}

	async notes(): Promise<ConceptNote[]> {
		return readJsonLines(this.notesPath, isNote);
	}

	/** Newest last, for the sessions detail view. */
	async recentNotes(limit = 20): Promise<ConceptNote[]> {
		return (await this.notes()).slice(-limit);
	}

	/**
	 * Session-end recap: 3 to 5 card candidates from noted concepts and the
	 * active lesson's last tutor messages. Single-flight; registered as an
	 * Activity job of kind "recap".
	 */
	recap(): Promise<Card[]> {
		if (this.#recapRunning) return this.#recapRunning;
		const run = this.#runRecap().finally(() => {
			this.#recapRunning = undefined;
		});
		this.#recapRunning = run;
		return run;
	}

	async #runRecap(): Promise<Card[]> {
		const job = this.deps.activity.start("recap", "Session recap");
		try {
			const since = this.#lastRecapAt;
			const startedAt = this.#clock.now();
			const notes = (await this.notes()).filter(
				(note) => Date.parse(note.at) > since,
			);
			const lessonId = this.#active;
			const record = lessonId ? await this.lessons.get(lessonId) : undefined;
			const tutorMessages = (record?.messages ?? [])
				.filter(
					(message) =>
						message.role === "tutor" && !message.id.startsWith("recap_"),
				)
				.filter((message) => Date.parse(message.at) > since)
				.slice(-6);
			if (notes.length === 0 && tutorMessages.length === 0) {
				this.#lastRecapAt = startedAt;
				job.update({ label: "Session recap: nothing new" });
				job.finish("done");
				return [];
			}
			if (record) this.#extract(record, true);
			await this.deps.services.graph?.flush?.();
			await this.deps.services.graph?.idle?.();
			const llm = this.deps.ports.llm;
			const blocked =
				llm.isCloud &&
				(this.#localOnly(record) ||
					notes.some(
						(note) => note.source && this.#sourceLocalOnly(note.source),
					));

			let candidates = heuristicCandidates(notes);
			if (!this.deps.fake && !blocked) {
				let prompt = recapPrompt(notes, tutorMessages);
				if (llm.isCloud)
					prompt = this.deps.services.privacy?.redact(prompt) ?? redact(prompt);
				try {
					candidates = await llmCandidates(llm, prompt, job.signal);
				} catch {
					// invalid model output: fall back to the noted concepts
				}
			}
			if (job.signal.aborted) {
				job.finish("error");
				return [];
			}
			const existing = new Set(
				(await this.cards.cards()).map((card) => card.propositionId),
			);
			const created: Card[] = [];
			for (const candidate of candidates.slice(0, 5)) {
				const propositionId = await resolvePropositionId(
					candidate,
					this.deps.services.graph,
				);
				if (!propositionId || existing.has(propositionId)) continue;
				existing.add(propositionId);
				const note = notes.find(
					(item) => item.concept === candidate.concept && item.source,
				);
				const proposition = await this.deps.services.graph?.get(propositionId);
				const source: SourceRef =
					proposition?.sources.find(
						(ref) => ref.kind === "web" || ref.kind === "pdf",
					) ??
					note?.source ??
					(record
						? {
								kind: "lesson",
								lessonId: record.id,
								messageId: tutorMessages.at(-1)?.id ?? "recap",
							}
						: sessionSource(this.deps.services));
				created.push(
					await this.cards.create({
						propositionId,
						question: candidate.question,
						...(candidate.example ? { example: candidate.example } : {}),
						source,
					}),
				);
			}
			const topics = [
				...new Set([
					...notes.map((note) => note.concept),
					...(record ? [record.title] : []),
				]),
			].slice(0, 8);
			const summary = [
				"# Session recap",
				`Topics discussed: ${topics.length ? topics.join(", ") : "the current study session"}.`,
				...(candidates.length
					? [
							"",
							"Recall prompts:",
							...candidates
								.slice(0, 5)
								.map((candidate) => `- ${candidate.question}`),
						]
					: []),
				"",
				`Added ${created.length} review card${created.length === 1 ? "" : "s"}.`,
			].join("\n");
			if (record) {
				await this.lessons.update(record.id, (fresh) => {
					fresh.messages.push({
						id: this.lessons.newId("recap"),
						at: new Date(this.#clock.now()).toISOString(),
						role: "tutor",
						kind: "text",
						text: summary,
					});
				});
				this.#changed();
			}
			this.deps.broadcast({
				type: "deep_update",
				turnId: job.id,
				documents: {
					research_scratchpad: { name: "Session recap", content: summary },
				},
			});
			this.#lastRecapAt = startedAt;
			job.update({
				label: `Session recap: ${created.length} card${created.length === 1 ? "" : "s"}`,
			});
			job.finish("done");
			if (created.length > 0) await this.broadcastDue();
			return created;
		} catch (error) {
			job.update({
				label: `Session recap failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			job.finish("error");
			throw error;
		}
	}
}

function sessionSource(services: Services): SourceRef {
	const bound = services.sessions?.bound();
	return {
		kind: "session",
		harness: bound?.harness ?? "unknown",
		...(bound?.path ? { file: bound.path } : {}),
		sessionId: bound?.sessionId ?? bound?.path ?? "unknown",
	};
}
