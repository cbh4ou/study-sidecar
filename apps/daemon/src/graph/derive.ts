import type { GraphSnapshot } from "../protocol.ts";
import type { GraphState } from "./store.ts";

/**
 * Build the read-side view: live nodes, live non-dangling chains, one
 * implication node per chain (id = chain id; edges premise -> implication
 * -> conclusion), and nodes grouped by `birthSource`, largest group first.
 */
export function deriveSnapshot(
	state: Pick<GraphState, "nodes" | "chains">,
	labels: Map<string, string> | Record<string, string> = {},
): GraphSnapshot {
	const live = new Set(state.nodes.map((n) => n.id));
	const chains = state.chains.filter(
		(c) =>
			live.has(c.conclusion) &&
			c.premises.length > 0 &&
			c.premises.every((p) => live.has(p)),
	);
	const label = (key: string): string | null =>
		(labels instanceof Map ? labels.get(key) : labels[key]) ?? null;
	const groups = new Map<string, string[]>();
	for (const node of state.nodes) {
		const ids = groups.get(node.birthSource) ?? [];
		ids.push(node.id);
		groups.set(node.birthSource, ids);
	}
	return {
		nodes: state.nodes,
		chains,
		implications: chains.map((c) => ({
			id: c.id,
			premises: c.premises,
			conclusion: c.conclusion,
		})),
		groups: [...groups.entries()]
			.map(([key, nodeIds]) => ({ key, label: label(key), nodeIds }))
			.sort(
				(a, b) =>
					b.nodeIds.length - a.nodeIds.length || a.key.localeCompare(b.key),
			),
	};
}
