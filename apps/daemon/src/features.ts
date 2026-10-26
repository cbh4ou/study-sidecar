import { createFakeReplayFeature } from "./adapters/fake-replay.ts";
import type { DaemonContext, Feature } from "./feature.ts";
import { createTelemetryFeature } from "./telemetry.ts";

/**
 * Feature registration order matters: services registered by earlier
 * features (telemetry, privacy, sessions, graph, learn) are visible to later
 * ones (lanes, mcp) by the time `start()` runs. Owned by the integrator.
 */
export function createFeatures(context: DaemonContext): Feature[] {
	return [createTelemetryFeature(context), createFakeReplayFeature(context)];
}
