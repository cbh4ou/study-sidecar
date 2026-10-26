import type { DaemonContext, Feature } from "./feature.ts";

/**
 * Feature registration order matters: services registered by earlier
 * features (privacy, sessions, graph, learn) are visible to later ones
 * (lanes, mcp) by the time `start()` runs. Owned by the integrator.
 */
export function createFeatures(context: DaemonContext): Feature[] {
	void context;
	return [];
}
