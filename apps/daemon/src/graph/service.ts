import type { ActivityRegistry } from "../activity.ts";
import type { LlmPort } from "../ports/llm.ts";
import type { DaemonMessage, GraphSnapshot, Proposition } from "../protocol.ts";
import type { GraphService, PrivacyGate } from "../services.ts";
import { deriveSnapshot } from "./derive.ts";
import {
	type ExtractionDeps,
	type ExtractionSource,
	type ProseMessage,
	runExtraction,
} from "./extraction.ts";
import { rankNodes } from "./search.ts";
import { messageHash } from "./simplify.ts";
import { GraphStore } from "./store.ts";

/** Uncovered prose budget that triggers a run (chars / 4). */
export const EXTRACTION_TOKEN_BUDGET = 4000;
/** Sources extracted concurrently; batches within a source are serial. */
export const MAX_CONCURRENT_SOURCES = 2;

export type GraphServiceDeps = {
	root: string;
	llm: LlmPort;
	fake?: boolean;
	activity?: ActivityRegistry;
	privacy?: () => PrivacyGate | undefined;
	broadcast?: (message: DaemonMessage) => void;
	now?: () => number;
	/** Extra group labels (e.g. lesson titles) consulted before noteProse labels. */
	labelFor?: (sourceId: string) => string | undefined;
	refs?: ExtractionDeps["refs"];
	newId?: ExtractionDeps["newId"];
	budget?: number;
	onError?: (sourceId: string, error: unknown) => void;
};

type SourceLane = {
	tail: Promise<void>;
	pending: Map<string, ProseMessage>;
};

/** Counting semaphore. */
class Gate {
	#active = 0;
	#waiters: Array<() => void> = [];
	constructor(private readonly limit: number) {}
	async acquire(): Promise<() => void> {
		if (this.#active >= this.limit)
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		this.#active++;
		return () => {
			this.#active--;
			this.#waiters.shift()?.();
		};
	}
}

export class GraphServiceImpl implements GraphService {
	readonly store: GraphStore;
	#lanes = new Map<string, SourceLane>();
	#covered: Promise<Set<string>> | undefined;
	#labels = new Map<string, string>();
	#gate: Gate;

	constructor(private readonly deps: GraphServiceDeps) {
		this.store = new GraphStore(deps.root);
		this.#gate = new Gate(MAX_CONCURRENT_SOURCES);
	}

	async snapshot(): Promise<GraphSnapshot> {
		const state = await this.store.read();
		const labels = new Map<string, string>();
		for (const node of state.nodes) {
			const label =
				this.deps.labelFor?.(node.birthSource) ??
				this.#labels.get(node.birthSource);
			if (label) labels.set(node.birthSource, label);
		}
		return deriveSnapshot(state, labels);
	}

	async search(text: string, limit = 10): Promise<Proposition[]> {
		const state = await this.store.read();
		return rankNodes(state.nodes, text, limit);
	}

	async recent(limit = 10): Promise<Proposition[]> {
		const state = await this.store.read();
		return state.nodes
			.map((node, index) => ({ node, index }))
			.sort(
				(a, b) =>
					b.node.createdAt.localeCompare(a.node.createdAt) || b.index - a.index,
			)
			.slice(0, Math.max(0, limit))
			.map((entry) => entry.node);
	}

	async get(id: string): Promise<Proposition | undefined> {
		return (await this.store.read()).byId.get(id);
	}

	/** Tombstone a node; undefined when unknown. Broadcasts graph_changed. */
	async delete(
		id: string,
	): Promise<{ deleted: string; chainsRemoved: string[] } | undefined> {
		const result = await this.store.tombstone(
			id,
			new Date(this.#now()).toISOString(),
		);
		if (result) this.deps.broadcast?.({ type: "graph_changed" });
		return result;
	}

	noteProse(
		source: ExtractionSource,
		messages: ProseMessage[],
		opts: { flush?: boolean } = {},
	): void {
		if (!this.#allowed(source)) return;
		if (source.label) this.#labels.set(source.id, source.label);
		const lane = this.#lane(source.id);
		lane.tail = lane.tail
			.then(() => this.#offer(source, lane, messages, opts.flush ?? false))
			.catch((error) => this.deps.onError?.(source.id, error));
	}

	/** Resolves when every queued offer and run has settled (tests, shutdown). */
	async idle(): Promise<void> {
		for (;;) {
			const tails = [...this.#lanes.values()].map((lane) => lane.tail);
			await Promise.all(tails);
			const now = [...this.#lanes.values()].map((lane) => lane.tail);
			if (now.every((tail, i) => tail === tails[i])) return;
		}
	}

	/** Messages waiting below the budget for a source (tests, diagnostics). */
	pendingCount(sourceId: string): number {
		return this.#lanes.get(sourceId)?.pending.size ?? 0;
	}

	#now(): number {
		return (this.deps.now ?? Date.now)();
	}

	#allowed(source: ExtractionSource): boolean {
		const privacy = this.deps.privacy?.();
		if (privacy?.indexIntoGraph(source.id) === false) return false;
		const localOnly = source.localOnly || privacy?.isLocalOnly(source.id);
		// Fake mode never calls the model, so local_only is safe there.
		if (localOnly && this.deps.llm.isCloud && !this.deps.fake) return false;
		return true;
	}

	#lane(sourceId: string): SourceLane {
		let lane = this.#lanes.get(sourceId);
		if (!lane) {
			lane = { tail: Promise.resolve(), pending: new Map() };
			this.#lanes.set(sourceId, lane);
		}
		return lane;
	}

	#coveredSet(): Promise<Set<string>> {
		this.#covered ??= this.store
			.coverage()
			.then(
				(lines) =>
					new Set(lines.map((l) => `${l.sourceId}\u0000${l.messageHash}`)),
			);
		return this.#covered;
	}

	async #offer(
		source: ExtractionSource,
		lane: SourceLane,
		messages: ProseMessage[],
		flush: boolean,
	): Promise<void> {
		const covered = await this.#coveredSet();
		for (const message of messages) {
			if (!message.text.trim()) continue;
			const hash = messageHash(message.text);
			if (covered.has(`${source.id}\u0000${hash}`)) continue;
			if (!lane.pending.has(hash)) lane.pending.set(hash, message);
		}
		if (!lane.pending.size) return;
		const tokens = [...lane.pending.values()].reduce(
			(sum, m) => sum + m.text.length / 4,
			0,
		);
		if (!flush && tokens < (this.deps.budget ?? EXTRACTION_TOKEN_BUDGET))
			return;
		const batch = [...lane.pending.entries()];
		lane.pending.clear();
		const ok = await this.#run(
			source,
			batch.map(([, m]) => m),
		);
		// On failure nothing was checkpointed and the batch is not retried here
		// (no hot retry loop); the messages stay uncovered, so the next offer
		// that includes them (callers re-offer transcripts) picks them up.
		if (ok)
			for (const [hash] of batch) covered.add(`${source.id}\u0000${hash}`);
	}

	async #run(
		source: ExtractionSource,
		batch: ProseMessage[],
	): Promise<boolean> {
		const release = await this.#gate.acquire();
		const job = this.deps.activity?.start(
			"extraction",
			`Extracting: ${source.label || source.id}`,
		);
		try {
			await runExtraction(
				{
					store: this.store,
					llm: this.deps.llm,
					fake: this.deps.fake,
					now: this.deps.now,
					signal: job?.signal,
					redact: this.deps.privacy?.()?.redact,
					refs: this.deps.refs,
					newId: this.deps.newId,
				},
				source,
				batch,
			);
			job?.finish("done");
			this.deps.broadcast?.({ type: "graph_changed" });
			return true;
		} catch (error) {
			job?.finish("error");
			this.deps.onError?.(source.id, error);
			return false;
		} finally {
			release();
		}
	}
}
