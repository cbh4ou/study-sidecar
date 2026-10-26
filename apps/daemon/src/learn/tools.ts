import type { MeasureLevel } from "../protocol.ts";
import { type ToolSpec, Type } from "../tool-spec.ts";
import type { Learn } from "./service.ts";

const LEVELS = new Set<MeasureLevel>(["solid", "shaky", "new"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function str(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} is required`);
	return value;
}

function optStr(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

/**
 * Deep-lane tools acting on the active lesson. Errors are thrown so the
 * model sees them and retries (e.g. plan_init parse errors).
 */
export function learnTools(service: Learn, _context?: unknown): ToolSpec[] {
	const active = (): string => {
		const id = service.activeLessonId();
		if (!id)
			throw new Error(
				"No active lesson. Ask the learner to open or start a lesson first.",
			);
		return id;
	};

	return [
		{
			name: "set_measure",
			description:
				"Record the Measure phase result: each prerequisite mapped to solid, shaky or new. Call once after 3 to 6 quick probes.",
			parameters: Type.Object({
				levels: Type.Record(
					Type.String(),
					Type.Union([
						Type.Literal("solid"),
						Type.Literal("shaky"),
						Type.Literal("new"),
					]),
				),
			}),
			async execute(args) {
				const id = active();
				if (!isRecord(args.levels)) throw new Error("levels must be an object");
				const levels: Record<string, MeasureLevel> = {};
				for (const [key, value] of Object.entries(args.levels)) {
					if (!LEVELS.has(value as MeasureLevel))
						throw new Error(`level for ${key} must be solid, shaky or new`);
					levels[key] = value as MeasureLevel;
				}
				if (Object.keys(levels).length === 0)
					throw new Error("levels needs at least one prerequisite");
				await service.setMeasure(id, levels);
				return `Measure recorded for ${Object.keys(levels).length} prerequisites.`;
			},
		},
		{
			name: "plan_init",
			description:
				"Author the lesson plan once as a prerequisite DAG in Mermaid (flowchart TD or LR; nodes A[Label]; edges A --> B or A --> B & C). Parse errors are returned with line numbers; fix and retry.",
			parameters: Type.Object({ mermaid: Type.String() }),
			async execute(args) {
				const detail = await service.setPlan(active(), str(args, "mermaid"));
				const current = detail.planNodes.find(
					(node) => node.status === "current",
				);
				return `Plan saved with ${detail.planNodes.length} nodes.${current ? ` Current: ${current.id} (${current.label}).` : ""}`;
			},
		},
		{
			name: "ask_question",
			description:
				"Put a question in the learner's question dock. kind quiz needs options and correctId (tag planNode to advance the plan); kind explain_back needs expectedPropositions (graph proposition ids); kind ask is open-ended.",
			parameters: Type.Object({
				kind: Type.Union([
					Type.Literal("quiz"),
					Type.Literal("ask"),
					Type.Literal("explain_back"),
				]),
				prompt: Type.String(),
				options: Type.Optional(
					Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
				),
				correctId: Type.Optional(Type.String()),
				planNode: Type.Optional(Type.String()),
				expectedPropositions: Type.Optional(Type.Array(Type.String())),
			}),
			async execute(args) {
				const id = active();
				const prompt = str(args, "prompt");
				const kind = args.kind;
				if (kind === "quiz") {
					if (!Array.isArray(args.options))
						throw new Error("quiz needs options");
					const options = args.options.map((option) => {
						if (
							!isRecord(option) ||
							typeof option.id !== "string" ||
							typeof option.label !== "string"
						)
							throw new Error("each option needs id and label");
						return { id: option.id, label: option.label };
					});
					const question = await service.askQuestion(id, {
						kind,
						prompt,
						options,
						correctId: str(args, "correctId"),
						planNode: optStr(args, "planNode"),
					});
					return `Quiz ${question.id} shown. Wait for the learner's answer.`;
				}
				if (kind === "explain_back") {
					const expected = args.expectedPropositions;
					if (
						!Array.isArray(expected) ||
						!expected.every((item) => typeof item === "string")
					)
						throw new Error("explain_back needs expectedPropositions");
					const question = await service.askQuestion(id, {
						kind,
						prompt,
						expectedPropositions: expected,
					});
					return `Explain-back ${question.id} shown. Wait for the learner's answer.`;
				}
				if (kind === "ask") {
					const question = await service.askQuestion(id, { kind, prompt });
					return `Question ${question.id} shown.`;
				}
				throw new Error("kind must be quiz, ask or explain_back");
			},
		},
		{
			name: "create_card",
			description:
				"Create a spaced-repetition card for a proposition the learner just passed. The question is a recall prompt that never names its answer; example may use the learner's own code.",
			parameters: Type.Object({
				propositionId: Type.String(),
				question: Type.String(),
				example: Type.Optional(Type.String()),
			}),
			async execute(args) {
				const lessonId = active();
				const lesson = await service.lesson(lessonId);
				const card = await service.createCard({
					propositionId: str(args, "propositionId"),
					question: str(args, "question"),
					example: optStr(args, "example"),
					source: {
						kind: "lesson",
						lessonId,
						messageId: lesson?.messages.at(-1)?.id ?? "tool",
					},
				});
				return `Card ${card.id} created.`;
			},
		},
		{
			name: "queue_gap",
			description:
				"Queue a prerequisite gap that is not needed for the current goal instead of chasing it now.",
			parameters: Type.Object({ topic: Type.String() }),
			async execute(args) {
				const detail = await service.queueGap(active(), str(args, "topic"));
				return `Queued. ${detail.queuedGaps.length} gap(s) waiting.`;
			},
		},
		{
			name: "add_lesson_source",
			description:
				"Attach a source to the lesson's Sources rail: {kind:'file',path,lines?}, {kind:'run',path,metric?,step?}, {kind:'pdf',path,page,quote?}, {kind:'web',url,quote?}, {kind:'session',...} or {kind:'lesson',...}.",
			parameters: Type.Object({
				source: Type.Object(
					{ kind: Type.String() },
					{ additionalProperties: true },
				),
			}),
			async execute(args) {
				const detail = await service.addSource(active(), args.source);
				return `Source added. ${detail.sources.length} source(s) on this lesson.`;
			},
		},
	];
}
