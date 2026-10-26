import { appendFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir, readJsonLines } from "../paths.ts";
import type { Chain, Proposition, SourceRef } from "../protocol.ts";
import {
	ChainSchema,
	type Coverage,
	CoverageSchema,
	isChain,
	isCoverage,
	isProposition,
	isTombstone,
	PropositionSchema,
	type Tombstone,
} from "./contracts.ts";

/** Merged, live view of the ledgers (tombstones applied, cascade done). */
export type GraphState = {
	nodes: Proposition[];
	chains: Chain[];
	/** Live node ids by id. */
	byId: Map<string, Proposition>;
	tombstoned: Set<string>;
};

export function graphDir(root: string): string {
	return join(root, "graph");
}

/** Stable key for "which source does this ref belong to" (lessonId or session path). */
export function sourceKey(ref: SourceRef): string {
	switch (ref.kind) {
		case "lesson":
			return ref.lessonId;
		case "session":
			return ref.file ?? ref.sessionId;
		case "web":
			return ref.url;
		default:
			return ref.path;
	}
}

function refKey(ref: SourceRef): string {
	return JSON.stringify(ref, Object.keys(ref).sort());
}

/** Union two SourceRef lists, preserving first-seen order. */
export function unionRefs(a: SourceRef[], b: SourceRef[]): SourceRef[] {
	const seen = new Set(a.map(refKey));
	const out = [...a];
	for (const ref of b) {
		const key = refKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

/**
 * Graph ledgers under `<root>/graph/`. Append-only JSONL; the read path
 * merges repeated ids (sources and aliases union, first createdAt and
 * birthSource win), drops tombstoned nodes and cascades to every chain that
 * references a tombstoned or unknown node. Writes go through the merger
 * (`appendBatch`) and the delete path (`tombstone`) only.
 */
export class GraphStore {
	constructor(readonly root: string) {}

	get dir(): string {
		return graphDir(this.root);
	}
	get nodesPath(): string {
		return join(this.dir, "nodes.jsonl");
	}
	get chainsPath(): string {
		return join(this.dir, "chains.jsonl");
	}
	get tombstonesPath(): string {
		return join(this.dir, "tombstones.jsonl");
	}
	get coveragePath(): string {
		return join(this.dir, "coverage.jsonl");
	}

	async read(): Promise<GraphState> {
		const [rawNodes, rawChains, tombstones] = await Promise.all([
			readJsonLines(this.nodesPath, isProposition),
			readJsonLines(this.chainsPath, isChain),
			readJsonLines(this.tombstonesPath, isTombstone),
		]);
		const tombstoned = new Set(tombstones.map((t) => t.id));
		const byId = new Map<string, Proposition>();
		for (const node of rawNodes) {
			const prior = byId.get(node.id);
			if (!prior) {
				byId.set(node.id, { ...node });
				continue;
			}
			const aliases = [
				...new Set([...(prior.aliases ?? []), ...(node.aliases ?? [])]),
			];
			byId.set(node.id, {
				...prior,
				name: node.name,
				statement: node.statement,
				...(aliases.length ? { aliases } : {}),
				sources: unionRefs(prior.sources, node.sources),
			});
		}
		for (const id of tombstoned) byId.delete(id);

		const chainsById = new Map<string, Chain>();
		for (const chain of rawChains) {
			if (tombstoned.has(chain.id)) continue;
			const ids = [...chain.premises, chain.conclusion];
			if (!ids.every((id) => byId.has(id))) continue; // cascade + dangling
			if (chain.premises.includes(chain.conclusion)) continue;
			const prior = chainsById.get(chain.id);
			chainsById.set(
				chain.id,
				prior
					? { ...prior, sources: unionRefs(prior.sources, chain.sources) }
					: chain,
			);
		}
		return {
			nodes: [...byId.values()],
			chains: [...chainsById.values()],
			byId,
			tombstoned,
		};
	}

	async coverage(): Promise<Coverage[]> {
		return readJsonLines(this.coveragePath, isCoverage);
	}

	/**
	 * Append one merged batch. Lines are serialized up front and each ledger
	 * receives a single append, so a bad value fails before anything lands.
	 */
	async appendBatch(batch: {
		nodes: Proposition[];
		chains: Chain[];
		coverage: Coverage[];
	}): Promise<void> {
		const encode = (values: unknown[]) =>
			values.map((value) => `${JSON.stringify(value)}\n`).join("");
		for (const node of batch.nodes) PropositionSchema.parse(node);
		for (const chain of batch.chains) ChainSchema.parse(chain);
		for (const line of batch.coverage) CoverageSchema.parse(line);
		const nodes = encode(batch.nodes);
		const chains = encode(batch.chains);
		const coverage = encode(batch.coverage);
		await ensurePrivateDir(this.dir);
		if (nodes) await appendPrivate(this.nodesPath, nodes);
		if (chains) await appendPrivate(this.chainsPath, chains);
		if (coverage) await appendPrivate(this.coveragePath, coverage);
	}

	/**
	 * Delete a live node: append its tombstone. Chains referencing it vanish
	 * from the read view (derived, nothing rewritten). Undefined when unknown.
	 */
	async tombstone(
		id: string,
		at = new Date().toISOString(),
	): Promise<{ deleted: string; chainsRemoved: string[] } | undefined> {
		const state = await this.read();
		if (!state.byId.has(id)) return undefined;
		const chainsRemoved = state.chains
			.filter((c) => c.conclusion === id || c.premises.includes(id))
			.map((c) => c.id);
		const line: Tombstone = { id, at };
		await ensurePrivateDir(this.dir);
		await appendPrivate(this.tombstonesPath, `${JSON.stringify(line)}\n`);
		return { deleted: id, chainsRemoved };
	}
}

async function appendPrivate(path: string, text: string): Promise<void> {
	await appendFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600).catch(() => undefined);
}
