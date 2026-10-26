import {
	DECIDE_OPTIONS,
	type DecideAdapterName,
	type DecidePort,
	type Intent,
	type LaneChoice,
} from "../ports/decide.ts";
import { redact } from "../tutor/redact.ts";
import { ruleIntent, ruleLane } from "./intent-rules.ts";

export type RouteResult = {
	intent: Intent;
	/** Only meaningful for question intents; `fast_only` otherwise. */
	lane: LaneChoice;
	decideMs: number;
	adapter: DecideAdapterName;
};

export type RouteOptions = {
	localOnly?: boolean;
	now?: () => number;
};

const QUESTION_INTENTS: ReadonlySet<Intent> = new Set([
	"question",
	"question_all_sessions",
	"command",
]);

export const isQuestionIntent = (intent: Intent): boolean =>
	QUESTION_INTENTS.has(intent);

/**
 * Intent then lane. Clear keyword signals skip the DecidePort entirely
 * (rules fast path); otherwise Decide composes Jev / LLM / rules.
 */
export async function route(
	text: string,
	decide: DecidePort,
	opts: RouteOptions = {},
): Promise<RouteResult> {
	const now = opts.now ?? (() => performance.now());
	const started = now();
	const input = redact(text);
	const decideOpts = opts.localOnly ? { localOnly: true } : {};
	let adapter: DecideAdapterName = "rules";
	let intent = ruleIntent(text);
	if (!intent) {
		try {
			const decision = await decide.decide(
				"intent",
				input,
				DECIDE_OPTIONS.intent,
				decideOpts,
			);
			intent = decision.choice;
			adapter = decision.adapter;
		} catch {
			intent = "question";
		}
	}
	let lane: LaneChoice = "fast_only";
	if (isQuestionIntent(intent)) {
		const keyword = ruleLane(text);
		if (keyword === "needs_web") lane = keyword;
		else
			try {
				const decision = await decide.decide(
					"lane",
					input,
					DECIDE_OPTIONS.lane,
					decideOpts,
				);
				lane = decision.choice;
				if (adapter === "rules") adapter = decision.adapter;
			} catch {
				lane = "fast_and_deep";
			}
	}
	return {
		intent,
		lane,
		decideMs: Math.max(0, Math.round(now() - started)),
		adapter,
	};
}
