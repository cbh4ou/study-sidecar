import { z } from "zod";
import { SourceRefSchema } from "../graph/contracts.ts";

const text = z.string().trim().min(1);
const at = z.iso.datetime({ offset: true });
export const MeasureSchema = z.record(text, z.enum(["solid", "shaky", "new"]));
export const QuestionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("quiz"),
			id: text,
			prompt: text,
			options: z.array(z.object({ id: text, label: text })).min(2),
			correctId: text,
			planNode: text.optional(),
		})
		.refine(
			(q) =>
				new Set(q.options.map((o) => o.id)).size === q.options.length &&
				q.options.some((o) => o.id === q.correctId),
			"quiz option ids must be unique and include correctId",
		),
	z.object({ kind: z.literal("ask"), id: text, prompt: text }),
	z.object({
		kind: z.literal("explain_back"),
		id: text,
		prompt: text,
		expectedPropositions: z.array(text).min(1),
	}),
]);
export const LessonMessageSchema = z.object({
	id: text,
	at,
	role: z.enum(["tutor", "learner"]),
	kind: z.enum(["text", "think_aloud"]),
	text: z.string(),
});
export const LessonAnswerSchema = z.object({
	value: z.string(),
	correct: z.boolean().optional(),
	verdict: z
		.enum(["correct", "partial", "misconception", "off_topic"])
		.optional(),
});
export const LessonRecordSchema = z.object({
	id: z.string().regex(/^les_[a-z0-9_]+$/),
	title: text.max(80),
	goal: text.max(500),
	anchors: z.array(SourceRefSchema).max(8),
	measure: MeasureSchema.optional(),
	phase: z.enum(["measure", "plan", "teach"]),
	planMermaid: z.string().optional(),
	sessionPath: text.optional(),
	createdAt: at,
	updatedAt: at,
	messages: z.array(LessonMessageSchema),
	questions: z.array(QuestionSchema),
	answers: z.record(z.string(), LessonAnswerSchema),
	queuedGaps: z.array(text),
	sources: z.array(SourceRefSchema).max(24),
});
export const CardSchema = z.object({
	id: text,
	propositionId: text,
	question: text,
	example: z.string().optional(),
	source: SourceRefSchema,
	createdAt: at,
});
export const ReviewSchema = z.object({
	cardId: text,
	at,
	rating: z.enum(["again", "hard", "good", "easy"]),
	by: z.enum(["button", "voice", "explain_back"]),
	answerText: z.string().optional(),
});
export const ConceptNoteSchema = z.object({
	concept: text.max(200),
	why: z.string().max(500).optional(),
	source: SourceRefSchema.optional(),
	at,
});
export const CreateLessonSchema = z.object({
	goal: text.max(500),
	title: text.max(80).optional(),
	anchor: SourceRefSchema.optional(),
	anchors: z.array(SourceRefSchema).max(8).optional(),
	sessionPath: text.optional(),
});
