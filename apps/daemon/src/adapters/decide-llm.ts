import { z } from "zod";
import type {
	DecideOptions,
	DecidePort,
	DecideTask,
	Decision,
} from "../ports/decide.ts";
import type { LlmPort } from "../ports/llm.ts";
import { redact } from "../tutor/redact.ts";

const Reply = z.object({
	choice: z.string(),
	confidence: z.number().min(0).max(1).optional(),
});

const TASK_HINTS: Record<DecideTask, string> = {
	delta_class:
		"How much should a study tutor react to this coding-session event?",
	turn_relevance:
		"Should this session turn be included in the tutor's context, kept as a short receipt, or dropped?",
	concept_route:
		"Which existing concept id does this text belong to, or is it a new concept?",
	intent: "What does the learner want with this utterance?",
	lane: "Which answering lane does this question need?",
	nudge_gate: "Should the tutor nudge the learner right now?",
	explain_back:
		"Grade the learner's explanation against the expected propositions.",
	fsrs_rating: "Rate recall quality for this spaced-repetition review.",
	anchor_pick: "Which code hunk id best anchors this lesson?",
};

/** Structured-output classifier over the fast lane. */
export class LlmDecide implements DecidePort {
	constructor(private readonly llm: LlmPort) {}

	get isCloud(): boolean {
		return this.llm.isCloud;
	}

	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>> {
		if (opts?.localOnly && this.llm.isCloud)
			throw new Error("Local-only input cannot be classified by a cloud model");
		input = redact(input);
		if (options.length === 0) throw new Error(`decide ${task}: no options`);
		const started = performance.now();
		const raw = await this.llm.complete({
			lane: "fast",
			json: true,
			maxTokens: 64,
			system: `You are a closed-set classifier. ${TASK_HINTS[task]}\nAnswer with JSON only: {"choice": <one of the options>, "confidence": <number 0..1>}.`,
			messages: [
				{
					role: "user",
					content: `Options: ${JSON.stringify(options)}\n\nInput:\n${input}`,
				},
			],
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`llm decide ${task}: reply is not JSON`);
		}
		const reply = Reply.safeParse(parsed);
		if (!reply.success)
			throw new Error(`llm decide ${task}: ${reply.error.message}`);
		const choice = options.find((option) => option === reply.data.choice);
		if (choice === undefined)
			throw new Error(
				`llm decide ${task}: choice "${reply.data.choice}" is not an option`,
			);
		const confidence = reply.data.confidence ?? 0.75;
		const rest = (1 - confidence) / Math.max(1, options.length - 1);
		const probs = Object.fromEntries(
			options.map((option) => [option, option === choice ? confidence : rest]),
		) as Record<T, number>;
		return {
			choice,
			probs,
			confidence,
			adapter: "llm",
			ms: Math.round(performance.now() - started),
		};
	}
}
