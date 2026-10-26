import type { SessionEvent } from "../ingest/events.ts";
import { ruleIntent, ruleLane } from "../lanes/intent-rules.ts";
import type { TutorMode } from "../modes/modes.ts";
import {
	certain,
	type DecideOptions,
	type DecidePort,
	type DecideTask,
	type Decision,
} from "../ports/decide.ts";
import { classifyDelta } from "../tutor/engine.ts";

const RECEIPT_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "view"]);

function eventOf(context?: Record<string, unknown>): SessionEvent | undefined {
	const event = context?.event;
	return event && typeof event === "object" && "event_type" in event
		? (event as SessionEvent)
		: undefined;
}

function turnRelevance(event: SessionEvent | undefined): string {
	if (!event) return "include";
	if (event.event_type === "agent_thought") return "drop";
	if (event.is_error) return "include";
	const tool = event.tool_name?.toLowerCase();
	if (event.event_type === "tool_result" && tool && RECEIPT_TOOLS.has(tool))
		return "receipt_only";
	return "include";
}

function fsrsRating(input: string): string {
	const t = input.toLowerCase();
	if (/\b(misconception|off_topic|off topic|wrong|incorrect)\b/.test(t))
		return "again";
	if (/\bpartial(ly)?\b/.test(t)) return "hard";
	if (/\bcorrect\b/.test(t)) return "good";
	return "good";
}

/** The rule choice before it is clamped to `options`. */
export function ruleChoice(
	task: DecideTask,
	input: string,
	options: readonly string[],
	context?: Record<string, unknown>,
): string | undefined {
	switch (task) {
		case "delta_class": {
			const event = eventOf(context);
			const mode = context?.mode as TutorMode | undefined;
			const findings = Array.isArray(context?.findings)
				? (context.findings as string[])
				: [];
			if (!event || !mode?.wake_triggers) return "SILENT";
			return classifyDelta(event, mode, findings);
		}
		case "intent":
			return ruleIntent(input) ?? "question";
		case "lane":
			return ruleLane(input);
		case "turn_relevance":
			return turnRelevance(eventOf(context));
		case "concept_route":
			return options.includes("new_concept") ? "new_concept" : options[0];
		case "nudge_gate":
			return "hold";
		case "explain_back":
			return "partial";
		case "fsrs_rating":
			return fsrsRating(input);
		case "anchor_pick":
			return options.at(-1);
	}
}

/** Deterministic fallback adapter; always returns a member of `options`. */
export class RulesDecide implements DecidePort {
	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>> {
		const first = options[0];
		if (first === undefined) throw new Error(`decide ${task}: no options`);
		const started = performance.now();
		const choice = ruleChoice(task, input, options, opts?.context);
		const picked = options.find((option) => option === choice) ?? first;
		return certain(
			picked,
			options,
			"rules",
			Math.round(performance.now() - started),
		);
	}
}
