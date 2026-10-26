import type { Chain, Proposition, SourceRef } from "../protocol.ts";
import type { AuditorSubmit, Coverage, ExtractorSubmit } from "./contracts.ts";
import {
	chainId,
	messageHash,
	propositionId,
	simplifyChains,
} from "./simplify.ts";
import { type GraphState, type GraphStore, unionRefs } from "./store.ts";

export type MergeInput = {
	sourceId: string;
	submit: ExtractorSubmit;
	links: AuditorSubmit["links"];
	/** Provenance attached to every node and chain touched by this batch. */
	refs: SourceRef[];
	/** Batch messages; each becomes a coverage line. */
	messages: Array<{ id: string; text: string }>;
	now: number;
	/** Injectable for deterministic tests. */
	newId?: (now: number) => string;
};

export type MergePlan = {
	nodes: Proposition[];
	chains: Chain[];
	coverage: Coverage[];
	/** local id -> final `n_` id. */
	idMap: Map<string, string>;
	/** New chains dropped by dedupe or simplify. */
	dropped: number;
};

/** Chains whose endpoints touch this source's propositions. */
export function sourceChains(state: GraphState, sourceId: string): Chain[] {
	const own = new Set(
		state.nodes.filter((n) => n.birthSource === sourceId).map((n) => n.id),
	);
	return state.chains.filter(
		(c) => own.has(c.conclusion) || c.premises.some((p) => own.has(p)),
	);
}

/**
 * Deterministic merge plan (no I/O). Resolves auditor identity links, maps
 * local ids to fresh `n_` ids, dedupes chains by (sorted premises,
 * conclusion), runs simplify over this source's chains plus the new ones
 * (existing chains preferred, the rest of the graph as entailment context),
 * and builds coverage lines. Throws on an unresolvable id so the caller
 * writes nothing.
 */
export function planMerge(state: GraphState, input: MergeInput): MergePlan {
	const createdAt = new Date(input.now).toISOString();
	const mint = input.newId ?? propositionId;
	const localIds = new Set(input.submit.propositions.map((p) => p.id));
	const linkFor = new Map<string, string>();
	for (const link of input.links) {
		if (!localIds.has(link.newId)) continue;
		if (!state.byId.has(link.existingId)) continue;
		linkFor.set(link.newId, link.existingId);
	}

	const idMap = new Map<string, string>();
	const nodes = new Map<string, Proposition>();
	for (const prop of input.submit.propositions) {
		const existingId = linkFor.get(prop.id);
		if (existingId) {
			idMap.set(prop.id, existingId);
			const existing = state.byId.get(existingId);
			if (!existing) continue;
			const aliases = [
				...new Set([
					...(existing.aliases ?? []),
					...(prop.name !== existing.name ? [prop.name] : []),
					...(prop.aliases ?? []),
				]),
			].filter((alias) => alias !== existing.name);
			const sources = unionRefs(existing.sources, input.refs);
			const changed =
				sources.length !== existing.sources.length ||
				aliases.length !== (existing.aliases ?? []).length;
			if (changed)
				nodes.set(existingId, {
					...existing,
					...(aliases.length ? { aliases } : {}),
					sources,
				});
			continue;
		}
		const id = mint(input.now);
		idMap.set(prop.id, id);
		nodes.set(id, {
			id,
			name: prop.name.slice(0, 80),
			statement: prop.statement,
			...(prop.aliases?.length ? { aliases: prop.aliases } : {}),
			sources: input.refs,
			createdAt,
			birthSource: input.sourceId,
		});
	}

	const resolve = (ref: string): string => {
		const mapped = idMap.get(ref);
		if (mapped) return mapped;
		if (state.byId.has(ref)) return ref;
		throw new Error(`unresolved proposition id ${ref}`);
	};

	const existingChains = new Map(state.chains.map((c) => [c.id, c]));
	const fresh = new Map<string, Chain>();
	let dropped = 0;
	for (const chain of input.submit.chains) {
		const premises = [...new Set(chain.premises.map(resolve))].sort();
		const conclusion = resolve(chain.conclusion);
		if (premises.includes(conclusion)) {
			dropped++;
			continue;
		}
		const id = chainId(premises, conclusion);
		if (fresh.has(id)) {
			dropped++;
			continue;
		}
		const prior = existingChains.get(id);
		if (prior) {
			const sources = unionRefs(prior.sources, input.refs);
			if (sources.length !== prior.sources.length)
				fresh.set(id, { ...prior, sources });
			else dropped++;
			continue;
		}
		fresh.set(id, { id, premises, conclusion, createdAt, sources: input.refs });
	}

	// Simplify this source's argument set; only new chains can be dropped.
	const own = sourceChains(state, input.sourceId);
	const ownIds = new Set(own.map((c) => c.id));
	const candidates = [
		...own,
		...[...fresh.values()].filter((c) => !ownIds.has(c.id)),
	];
	const context = state.chains.filter((c) => !ownIds.has(c.id));
	const kept = new Set(
		simplifyChains(candidates, {
			preferred: new Set(state.chains.map((c) => c.id)),
			context,
		}).map((c) => c.id),
	);
	const chains: Chain[] = [];
	for (const chain of fresh.values()) {
		if (existingChains.has(chain.id) || kept.has(chain.id)) chains.push(chain);
		else dropped++;
	}

	const coverage = [
		...new Set(input.messages.map((m) => messageHash(m.text))),
	].map((hash) => ({ sourceId: input.sourceId, messageHash: hash }));

	return { nodes: [...nodes.values()], chains, coverage, idMap, dropped };
}

/** The only ledger writer for extraction: plan, then append in one batch. */
export async function merge(
	store: GraphStore,
	state: GraphState,
	input: MergeInput,
	signal?: AbortSignal,
): Promise<MergePlan> {
	const plan = planMerge(state, input);
	if (signal?.aborted) throw new Error("extraction aborted");
	await store.appendBatch(plan);
	return plan;
}
