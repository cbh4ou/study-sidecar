import type {
	DecideOptions,
	DecidePort,
	DecideTask,
	Decision,
} from "../ports/decide.ts";
import type { LlmPort } from "../ports/llm.ts";
import type { StoredSettings } from "../settings.ts";

export type ComposedDecideOptions = {
	settings: { readonly value: StoredSettings };
	jev: DecidePort;
	llm: DecidePort;
	rules: DecidePort;
	/** The LLM behind `llm`; its `isCloud` gates local_only input. */
	llmPort: Pick<LlmPort, "isCloud">;
	/** Optional error sink (logging); never throws. */
	onError?: (adapter: "jev" | "llm", task: DecideTask, error: unknown) => void;
};

/** Tasks whose rule fallback is a placeholder (spec: "LLM adapter"). */
const LLM_PREFERRED = new Set<DecideTask>(["explain_back", "concept_route"]);

/**
 * Spec Section 10 composition: Jev (key set, input not local_only) ->
 * escalate to LLM when confidence < threshold -> rules on any error.
 */
export class ComposedDecide implements DecidePort {
	constructor(private readonly options: ComposedDecideOptions) {}

	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>> {
		const started = performance.now();
		const settings = this.options.settings.value.decide;
		const done = (decision: Decision<T>): Decision<T> => ({
			...decision,
			ms: Math.round(performance.now() - started),
		});
		const rules = async () =>
			done(await this.options.rules.decide(task, input, options, opts));
		if (settings.adapter === "rules") return rules();

		const threshold = Number.isFinite(settings.threshold)
			? settings.threshold
			: 0.7;
		const llmAllowed = !(opts?.localOnly && this.options.llmPort.isCloud);
		const jevAllowed =
			(settings.adapter === "auto" || settings.adapter === "jev") &&
			Boolean(settings.jevApiKey) &&
			!opts?.localOnly;

		let low: Decision<T> | undefined;
		if (jevAllowed) {
			try {
				const decision = await this.options.jev.decide(
					task,
					input,
					options,
					opts,
				);
				if (decision.confidence >= threshold) return done(decision);
				low = decision;
			} catch (error) {
				this.options.onError?.("jev", task, error);
				return rules();
			}
		}
		// "auto" without Jev uses the LLM only where rules are weak, so
		// high-volume tasks (delta_class per event, intent per turn) stay free.
		const tryLlm =
			llmAllowed &&
			(settings.adapter === "llm" ||
				low !== undefined ||
				(settings.adapter === "auto" &&
					!jevAllowed &&
					LLM_PREFERRED.has(task)));
		if (tryLlm) {
			try {
				return done(await this.options.llm.decide(task, input, options, opts));
			} catch (error) {
				this.options.onError?.("llm", task, error);
				return rules();
			}
		}
		if (low) return done(low);
		return rules();
	}
}
