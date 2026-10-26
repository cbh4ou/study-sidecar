import type { Ports } from "../feature.ts";
import { systemClock } from "../ports/clock.ts";
import type { SettingsStore } from "../settings.ts";
import { ComposedDecide } from "./decide-compose.ts";
import { FakeDecide } from "./decide-fake.ts";
import { JevDecide } from "./decide-jev.ts";
import { LlmDecide } from "./decide-llm.ts";
import { RulesDecide } from "./decide-rules.ts";
import { FakeLlm } from "./llm-fake.ts";
import { createPiLlm } from "./llm-pi.ts";
import { FakeWeb } from "./web-fake.ts";
import { WebProvider } from "./web-provider.ts";

export type PortOptions = {
	home: string;
	root: string;
	fake: boolean;
	settings: SettingsStore;
	modelSlug?: string;
};

/**
 * Wire every port. Fake mode uses deterministic fakes only. Real mode reads
 * settings at call time, so lane models, Decide adapter, and web keys can
 * change without a restart; a missing model only errors when a lane is used.
 */
export async function createPorts(options: PortOptions): Promise<Ports> {
	if (options.fake)
		return {
			clock: systemClock,
			llm: new FakeLlm(),
			decide: new FakeDecide(),
			web: new FakeWeb(),
		};
	const llm = await createPiLlm({
		home: options.home,
		settings: options.settings,
		modelSlug: options.modelSlug,
	});
	return {
		clock: systemClock,
		llm,
		decide: new ComposedDecide({
			settings: options.settings,
			jev: new JevDecide({ settings: options.settings }),
			llm: new LlmDecide(llm),
			rules: new RulesDecide(),
			llmPort: llm,
			onError: (adapter, task, error) =>
				console.warn(
					`[decide] ${adapter} failed for ${task}: ${error instanceof Error ? error.message : String(error)}`,
				),
		}),
		web: new WebProvider({ settings: options.settings }),
	};
}
