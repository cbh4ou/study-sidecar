import type { Ports } from "../feature.ts";
import { systemClock } from "../ports/clock.ts";
import { certain } from "../ports/decide.ts";
import type { SettingsStore } from "../settings.ts";

export type PortOptions = {
	home: string;
	root: string;
	fake: boolean;
	settings: SettingsStore;
	modelSlug?: string;
};

/**
 * PLACEHOLDER (P0): replaced by workstream A with real/fake adapter wiring.
 * Keeps the daemon bootable before adapters land.
 */
export async function createPorts(options: PortOptions): Promise<Ports> {
	void options;
	return {
		clock: systemClock,
		llm: {
			isCloud: false,
			async *stream() {
				yield* [];
				throw new Error("llm port not configured");
			},
			async complete() {
				throw new Error("llm port not configured");
			},
		},
		decide: {
			async decide(_task, _input, options) {
				const first = options[0];
				if (first === undefined) throw new Error("no options");
				return certain(first, options, "rules");
			},
		},
		web: {
			configured: false,
			async search() {
				return [];
			},
			async fetch() {
				throw new Error("web search not configured");
			},
		},
	};
}
