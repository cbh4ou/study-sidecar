import { z } from "zod";
import type {
	DecideOptions,
	DecidePort,
	DecideTask,
	Decision,
} from "../ports/decide.ts";
import type { StoredSettings } from "../settings.ts";
import { redact } from "../tutor/redact.ts";
import { TASK_HINTS } from "./decide-llm.ts";

/**
 * TypeSafe Jev System One adapter. The wire shape lives only in this file;
 * if the real API differs, only this file changes.
 */
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 5_000;

const JevChoice = z.object({
	type: z.literal("choice"),
	choice: z.string(),
	probabilities: z.record(z.string(), z.number().min(0).max(1)),
	confidence: z.number().min(0).max(1),
});

const JevResponse = z.object({ answers: z.record(z.string(), JevChoice) });

export type FetchImpl = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type JevDecideOptions = {
	settings: { readonly value: StoredSettings };
	fetchImpl?: FetchImpl;
	timeoutMs?: number;
};

export class JevDecide implements DecidePort {
	constructor(private readonly options: JevDecideOptions) {}

	get configured(): boolean {
		return Boolean(this.options.settings.value.decide.jevApiKey);
	}

	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>> {
		if (opts?.localOnly)
			throw new Error("jev decide refused: input is from a local_only source");
		const { jevApiKey, jevUrl } = this.options.settings.value.decide;
		if (!jevApiKey) throw new Error("jev decide: no API key configured");
		if (options.length === 0) throw new Error(`decide ${task}: no options`);
		if (options.some((option) => redact(option) !== option))
			throw new Error("Decision option contains sensitive text");
		const started = performance.now();
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(jevUrl || DEFAULT_JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${jevApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "jev-latest",
				state: redact(input),
				questions: {
					[task]: {
						type: "choice",
						instructions: TASK_HINTS[task],
						criteria: Object.fromEntries(
							options.map((option) => [option, option.replaceAll("_", " ")]),
						),
					},
				},
			}),
			signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
		});
		if (!response.ok)
			throw new Error(`jev decide ${task}: HTTP ${response.status}`);
		const parsed = JevResponse.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(`jev decide ${task}: ${parsed.error.message}`);
		const answer = parsed.data.answers[task];
		if (
			!answer ||
			options.some((option) => answer.probabilities[option] === undefined)
		)
			throw new Error(`jev decide ${task}: incomplete answer distribution`);
		const choice = options.find((option) => option === answer.choice);
		if (choice === undefined)
			throw new Error(
				`jev decide ${task}: choice "${answer.choice}" is not an option`,
			);
		const confidence = answer.confidence;
		const probs = Object.fromEntries(
			options.map((option) => [option, answer.probabilities[option] ?? 0]),
		) as Record<T, number>;
		return {
			choice,
			probs,
			confidence,
			adapter: "jev",
			ms: Math.round(performance.now() - started),
		};
	}
}
