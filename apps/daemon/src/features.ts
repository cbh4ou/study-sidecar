import { createFakeReplayFeature } from "./adapters/fake-replay.ts";
import { createAnchorFeature } from "./anchors.ts";
import type { DaemonContext, Feature } from "./feature.ts";
import { createGraphFeature } from "./graph/feature.ts";
import { createLanesFeature } from "./lanes/feature.ts";
import { createLearnFeature } from "./learn/feature.ts";
import { createMcpRoutesFeature } from "./mcp/routes.ts";
import { OKFStore } from "./memory/okf-store.ts";
import { createPrivacyFeature } from "./privacy/sources.ts";
import { createSessionsFeature } from "./sessions/feature.ts";
import type { IngestBinding } from "./sessions/registry.ts";
import { createSettingsFeature } from "./settings-routes.ts";
import { createTelemetryFeature } from "./telemetry.ts";

/**
 * Feature registration order matters: services registered by earlier
 * features (telemetry, privacy, sessions, graph, learn) are visible to later
 * ones (lanes, mcp) by the time `start()` runs. Owned by the integrator.
 */
export function createFeatures(
	context: DaemonContext,
	ingest: IngestBinding,
): Feature[] {
	return [
		createTelemetryFeature(context),
		createPrivacyFeature(context),
		createSettingsFeature(context),
		createSessionsFeature(
			context,
			ingest,
			context.fake
				? { directories: { pi: [], omp: [], codex: [], claude: [], auto: [] } }
				: {},
		),
		createGraphFeature(context),
		createLearnFeature(context),
		createAnchorFeature(context),
		createLanesFeature(context, {
			recall: async (query) =>
				(
					await new OKFStore().query(
						query,
						undefined,
						(source) => context.services.privacy?.allowCloud(source) ?? false,
					)
				).map((hit) => `${hit.title}: ${hit.preview}`),
		}),
		createMcpRoutesFeature(context),
		createFakeReplayFeature(context),
	];
}
