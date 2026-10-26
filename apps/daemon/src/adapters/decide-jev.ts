import { z } from "zod";
import type {
	DecideOptions,
	DecidePort,
	DecideTask,
	Decision,
} from "../ports/decide.ts";
import type { StoredSettings } from "../settings.ts";
import { redact } from "../tutor/redact.ts";

/**
 * TypeSafe Jev System One adapter. The wire shape lives only in this file;
 * if the real API differs, only this file changes.
 */
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/decide";
const TIMEOUT_MS = 5_000;

const JevResponse = z.object({
	choice: z.string(),
	probs: z.record(z.string(), z.number()).optional(),
	confidence: z.number().min(0).max(1),
});

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
		const started = performance.now();
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(jevUrl || DEFAULT_JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${jevApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ task, input: redact(input), options }),
			signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS),
		});
		if (!response.ok)
			throw new Error(`jev decide ${task}: HTTP ${response.status}`);
		const parsed = JevResponse.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(`jev decide ${task}: ${parsed.error.message}`);
		const choice = options.find((option) => option === parsed.data.choice);
		if (choice === undefined)
			throw new Error(
				`jev decide ${task}: choice "${parsed.data.choice}" is not an option`,
			);
		const confidence = parsed.data.confidence;
		const rest = (1 - confidence) / Math.max(1, options.length - 1);
		const probs = Object.fromEntries(
			options.map((option) => [
				option,
				parsed.data.probs?.[option] ?? (option === choice ? confidence : rest),
			]),
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
