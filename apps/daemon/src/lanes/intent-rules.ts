import type { Intent, LaneChoice } from "../ports/decide.ts";

/**
 * Deterministic intent/lane rules: the `rules` Decide adapter's behavior for
 * the `intent` and `lane` tasks, and a fast pre-check before any adapter.
 * Returns undefined when the text carries no clear keyword signal.
 */
export function ruleIntent(text: string): Intent | undefined {
	const t = text
		.trim()
		.toLowerCase()
		.replace(/[.!?]+$/, "");
	if (!t) return "cancel";
	if (
		/^(stop|cancel|never ?mind|forget it|shut up|quiet|be quiet|hold on)$/.test(
			t,
		)
	)
		return "cancel";
	if (
		/\b(send|hand|pass|bridge|give) (that|this|it)? ?back\b/.test(t) ||
		/\bback to (claude|pi|codex|the terminal|the agent|omp|hermes)\b/.test(t) ||
		/\bsteering prompt\b/.test(t)
	)
		return "bridge_back";
	if (/\b(across|in) all (my )?sessions\b|\bevery session\b/.test(t))
		return "question_all_sessions";
	if (
		/^(note|noting|thinking out loud|i think|i guess|hmm+|so basically)\b/.test(
			t,
		) &&
		!t.includes("?")
	)
		return "think_aloud";
	if (
		/^(pin (this|that)|open (the )?app|expand|collapse|mute|unmute)\b/.test(t)
	)
		return "command";
	if (
		t.includes("?") ||
		/^(what|why|how|when|where|which|who|is|are|does|do|can|could|should|explain|tell me)\b/.test(
			t,
		)
	)
		return "question";
	return undefined;
}

export function ruleLane(text: string): LaneChoice {
	const t = text.toLowerCase();
	if (
		/\b(search|look up|latest|on the web|online|paper|papers|docs for|documentation)\b/.test(
			t,
		)
	)
		return "needs_web";
	return "fast_and_deep";
}
