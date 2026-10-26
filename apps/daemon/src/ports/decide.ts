/** Closed-set decision tasks (spec Section 10). */
export type DecideTask =
	| "delta_class"
	| "turn_relevance"
	| "concept_route"
	| "intent"
	| "lane"
	| "nudge_gate"
	| "explain_back"
	| "fsrs_rating"
	| "anchor_pick";

export type DecideAdapterName = "jev" | "llm" | "rules" | "fake";

export type Decision<T extends string> = {
	choice: T;
	probs: Record<T, number>;
	confidence: number;
	adapter: DecideAdapterName;
	ms: number;
};

export type DecideOptions = {
	/** Input originates from a `local_only` source: no cloud adapter may see it. */
	localOnly?: boolean;
	/** Extra structured context for rule adapters (e.g. the SessionEvent). */
	context?: Record<string, unknown>;
};

/**
 * Fast closed-set judgments. Never used to parse structure or generate text.
 * Implementations must return one of `options`.
 */
export interface DecidePort {
	decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>>;
}

/** Option sets shared by callers and adapters. */
export const DECIDE_OPTIONS = {
	delta_class: ["SILENT", "AMBIENT_PILL", "PROACTIVE_COACH"],
	turn_relevance: ["include", "receipt_only", "drop"],
	intent: [
		"question",
		"question_all_sessions",
		"think_aloud",
		"command",
		"cancel",
		"bridge_back",
	],
	lane: ["fast_only", "fast_and_deep", "needs_web"],
	nudge_gate: ["nudge", "hold"],
	explain_back: ["correct", "partial", "misconception", "off_topic"],
	fsrs_rating: ["again", "hard", "good", "easy"],
} as const;

export type Intent = (typeof DECIDE_OPTIONS.intent)[number];
export type LaneChoice = (typeof DECIDE_OPTIONS.lane)[number];
export type ExplainBackVerdict = (typeof DECIDE_OPTIONS.explain_back)[number];

/** Uniform probabilities with all mass on `choice` (rule/fake adapters). */
export function certain<T extends string>(
	choice: T,
	options: readonly T[],
	adapter: DecideAdapterName,
	ms = 0,
	confidence = 1,
): Decision<T> {
	const probs = Object.fromEntries(
		options.map((option) => [
			option,
			option === choice
				? confidence
				: (1 - confidence) / Math.max(1, options.length - 1),
		]),
	) as Record<T, number>;
	return { choice, probs, confidence, adapter, ms };
}
