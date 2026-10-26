import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityRegistry } from "../activity.ts";
import type { DaemonContext } from "../feature.ts";
import { FakeClock } from "../ports/clock.ts";
import type { LlmPort, LlmRequest } from "../ports/llm.ts";
import type { DaemonMessage, Proposition } from "../protocol.ts";
import type { PrivacyGate, Services } from "../services.ts";
import { deriveSnapshot } from "./derive.ts";
import { heuristicExtract, runExtraction } from "./extraction.ts";
import { createGraphFeature } from "./feature.ts";
import { planMerge } from "./merger.ts";
import { GraphServiceImpl } from "./service.ts";
import { chainId, propositionId, simplifyChains } from "./simplify.ts";
import { GraphStore } from "./store.ts";
import { graphTools } from "./tools.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sidecar-graph-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

class ScriptedLlm implements LlmPort {
	calls: LlmRequest[] = [];
	constructor(
		private readonly replies: Array<string | ((req: LlmRequest) => string)>,
		readonly isCloud = false,
	) {}
	async *stream(): AsyncIterable<string> {}
	async complete(request: LlmRequest): Promise<string> {
		this.calls.push(structuredClone({ ...request, signal: undefined }));
		const next = this.replies.shift();
		if (next === undefined) throw new Error("no scripted reply");
		return typeof next === "function" ? next(request) : next;
	}
}

let seq = 0;
const ids = () => `n_TEST${String(++seq).padStart(4, "0")}`;

async function ledgerText(): Promise<string> {
	const files = ["nodes", "chains", "tombstones", "coverage"];
	const parts = await Promise.all(
		files.map((f) =>
			readFile(join(root, "graph", `${f}.jsonl`), "utf8").catch(() => ""),
		),
	);
	return parts.join("");
}

function node(id: string, birthSource = "lesson-1", name = id): Proposition {
	return {
		id,
		name,
		statement: `${name} statement`,
		sources: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		birthSource,
	};
}

const good = JSON.stringify({
	propositions: [
		{
			id: "p1",
			name: "Acks confirm delivery",
			statement: "An ack confirms delivery.",
		},
		{
			id: "p2",
			name: "Retries need acks",
			statement: "Retries depend on acks.",
		},
	],
	chains: [{ premises: ["p1"], conclusion: "p2" }],
});

describe("T5 extraction", () => {
	test("invalid submit triggers retry with the error fed back", async () => {
		const llm = new ScriptedLlm([
			"not json at all",
			JSON.stringify({ propositions: [{ id: "p1" }], chains: [] }),
			good,
		]);
		const store = new GraphStore(root);
		const result = await runExtraction(
			{ store, llm, newId: ids },
			{ id: "lesson-1", label: "Lesson" },
			[{ id: "m1", text: "An ack confirms delivery. Retries depend on acks." }],
		);
		expect(llm.calls).toHaveLength(3);
		const second = llm.calls[1]?.messages.at(-1)?.content ?? "";
		expect(second).toContain("Submit rejected: invalid JSON");
		const third = llm.calls[2]?.messages.at(-1)?.content ?? "";
		expect(third).toContain("propositions.0.name");
		expect(llm.calls[0]?.messages[0]?.content).toContain("GRAPH SO FAR");
		expect(result.nodes).toHaveLength(2);
		const state = await store.read();
		expect(state.nodes).toHaveLength(2);
		expect(state.chains).toHaveLength(1);
		expect(await store.coverage()).toHaveLength(1);
	});

	test("unknown chain endpoint is reported back", async () => {
		const bad = JSON.stringify({
			propositions: [{ id: "p1", name: "A", statement: "A holds." }],
			chains: [{ premises: ["p9"], conclusion: "p1" }],
		});
		const llm = new ScriptedLlm([bad, good]);
		await runExtraction(
			{ store: new GraphStore(root), llm },
			{ id: "s", label: "s" },
			[{ id: "m", text: "x" }],
		);
		expect(llm.calls[1]?.messages.at(-1)?.content).toContain(
			"unknown proposition id p9",
		);
	});

	test("extractor failure after 3 turns writes nothing", async () => {
		const llm = new ScriptedLlm(["{}", "{}", "{}"]);
		const store = new GraphStore(root);
		await expect(
			runExtraction({ store, llm }, { id: "s", label: "s" }, [
				{ id: "m", text: "t" },
			]),
		).rejects.toThrow("extractor failed after 3 turns");
		expect(llm.calls).toHaveLength(3);
		expect(await ledgerText()).toBe("");
	});

	test("auditor failure writes nothing", async () => {
		const store = new GraphStore(root);
		await store.appendBatch({
			nodes: [
				{
					...node("n_OLD", "s", "Acks confirm delivery"),
					statement: "An ack confirms delivery.",
				},
			],
			chains: [],
			coverage: [],
		});
		const before = await ledgerText();
		const llm = new ScriptedLlm([good, "nope", "nope", "nope"]);
		await expect(
			runExtraction({ store, llm }, { id: "s", label: "s" }, [
				{ id: "m", text: "t" },
			]),
		).rejects.toThrow("auditor failed");
		expect(await ledgerText()).toBe(before);
	});

	test("aborted run writes nothing", async () => {
		const controller = new AbortController();
		const llm = new ScriptedLlm([
			() => {
				controller.abort();
				return good;
			},
		]);
		await expect(
			runExtraction(
				{ store: new GraphStore(root), llm, signal: controller.signal },
				{ id: "s", label: "s" },
				[{ id: "m", text: "t" }],
			),
		).rejects.toThrow("aborted");
		expect(await ledgerText()).toBe("");
	});

	test("auditor links resolve to existing ids and add an alias", async () => {
		const store = new GraphStore(root);
		const existing = {
			...node("n_OLD", "other", "Ack confirms delivery"),
			statement: "An ack confirms delivery.",
		};
		await store.appendBatch({ nodes: [existing], chains: [], coverage: [] });
		const llm = new ScriptedLlm([
			good,
			(req) => {
				expect(req.messages[0]?.content).toContain("candidate n_OLD");
				return JSON.stringify({
					links: [
						{ newId: "p1", existingId: "n_OLD" },
						{ newId: "p2", existingId: "n_NOT_OFFERED" },
					],
				});
			},
		]);
		const result = await runExtraction(
			{ store, llm, newId: ids },
			{ id: "s", label: "s" },
			[{ id: "m", text: "t" }],
		);
		expect(result.idMap.get("p1")).toBe("n_OLD");
		const state = await store.read();
		expect(state.nodes).toHaveLength(2);
		expect(state.byId.get("n_OLD")?.aliases).toEqual(["Acks confirm delivery"]);
		expect(state.byId.get("n_OLD")?.birthSource).toBe("other");
		expect(state.chains[0]?.premises).toEqual(["n_OLD"]);
	});

	test("cloud extractor receives redacted prose", async () => {
		const llm = new ScriptedLlm([good], true);
		await runExtraction(
			{ store: new GraphStore(root), llm },
			{ id: "s", label: "s" },
			[{ id: "m", text: "use api_key=supersecretvalue here" }],
		);
		const prompt = llm.calls[0]?.messages[0]?.content ?? "";
		expect(prompt).not.toContain("supersecretvalue");
	});

	test("merger dedupes identical chains and simplify drops the redundant one", async () => {
		const store = new GraphStore(root);
		const state = await store.read();
		const submit = {
			propositions: ["A", "B", "C", "X", "Y"].map((id) => ({
				id,
				name: id,
				statement: `${id} holds.`,
			})),
			chains: [
				{ premises: ["A", "B"], conclusion: "X" },
				{ premises: ["B", "A"], conclusion: "X" },
				{ premises: ["X", "C"], conclusion: "Y" },
				{ premises: ["A", "B", "C"], conclusion: "Y" },
			],
		};
		const plan = planMerge(state, {
			sourceId: "s",
			submit,
			links: [],
			refs: [],
			messages: [],
			now: 0,
			newId: ids,
		});
		const id = (local: string) => plan.idMap.get(local) ?? "";
		expect(plan.chains.map((c) => [c.premises, c.conclusion])).toEqual([
			[[id("A"), id("B")].sort(), id("X")],
			[[id("C"), id("X")].sort(), id("Y")],
		]);
		expect(plan.dropped).toBe(2);
	});

	test("re-submitting an existing chain is not duplicated", async () => {
		const store = new GraphStore(root);
		await store.appendBatch({
			nodes: [node("n_A"), node("n_B")],
			chains: [],
			coverage: [],
		});
		const submit = {
			propositions: [],
			chains: [{ premises: ["n_A"], conclusion: "n_B" }],
		};
		const input = {
			sourceId: "lesson-1",
			submit,
			links: [],
			refs: [],
			messages: [],
			now: 0,
		};
		const first = planMerge(await store.read(), input);
		await store.appendBatch(first);
		const second = planMerge(await store.read(), input);
		expect(first.chains).toHaveLength(1);
		expect(second.chains).toHaveLength(0);
	});
});

describe("simplify and ids", () => {
	test("fixture graph keeps [A,B]=>X and [X,C]=>Y", () => {
		const mk = (premises: string[], conclusion: string) => ({
			id: chainId(premises, conclusion),
			premises,
			conclusion,
		});
		const kept = simplifyChains([
			mk(["A", "B", "C"], "Y"),
			mk(["A", "B"], "X"),
			mk(["X", "C"], "Y"),
		]);
		expect(kept.map((c) => c.id).sort()).toEqual(
			[chainId(["A", "B"], "X"), chainId(["X", "C"], "Y")].sort(),
		);
	});

	test("strict superset dropped; independent arguments kept", () => {
		const mk = (premises: string[], conclusion: string) => ({
			id: chainId(premises, conclusion),
			premises,
			conclusion,
		});
		const kept = simplifyChains([
			mk(["A", "B"], "Y"),
			mk(["A"], "Y"),
			mk(["Q"], "Y"),
		]);
		expect(kept.map((c) => c.premises)).toEqual([["A"], ["Q"]]);
	});

	test("chain id is order independent; proposition ids are unique n_ ids", () => {
		expect(chainId(["b", "a"], "c")).toBe(chainId(["a", "b"], "c"));
		expect(chainId(["a"], "c")).toMatch(/^arg_[0-9a-f]{16}$/);
		const a = propositionId(1);
		const b = propositionId(2);
		expect(a).toMatch(/^n_[0-9A-Z]{26}$/);
		expect(a).not.toBe(b);
		expect(a < b).toBe(true);
	});
});

describe("T6 delete cascade", () => {
	test("deleting a proposition removes every chain referencing it", async () => {
		const store = new GraphStore(root);
		await store.appendBatch({
			nodes: ["n_A", "n_B", "n_C", "n_D"].map((id) => node(id)),
			chains: [
				{
					id: chainId(["n_A"], "n_B"),
					premises: ["n_A"],
					conclusion: "n_B",
					createdAt: "2026-01-01T00:00:00.000Z",
					sources: [],
				},
				{
					id: chainId(["n_B", "n_C"], "n_D"),
					premises: ["n_B", "n_C"],
					conclusion: "n_D",
					createdAt: "2026-01-01T00:00:00.000Z",
					sources: [],
				},
				{
					id: chainId(["n_C"], "n_A"),
					premises: ["n_C"],
					conclusion: "n_A",
					createdAt: "2026-01-01T00:00:00.000Z",
					sources: [],
				},
			],
			coverage: [],
		});
		const result = await store.tombstone("n_B");
		expect(result?.chainsRemoved.sort()).toEqual(
			[chainId(["n_A"], "n_B"), chainId(["n_B", "n_C"], "n_D")].sort(),
		);
		const snapshot = deriveSnapshot(await store.read());
		expect(snapshot.nodes.map((n) => n.id)).toEqual(["n_A", "n_C", "n_D"]);
		expect(snapshot.chains.map((c) => c.id)).toEqual([chainId(["n_C"], "n_A")]);
		expect(snapshot.implications).toHaveLength(1);
		expect(await store.tombstone("n_B")).toBeUndefined();
		const chainsLedger = await readFile(store.chainsPath, "utf8");
		expect(chainsLedger.trim().split("\n")).toHaveLength(3);
	});

	test("corrupt ledger lines are dropped", async () => {
		const store = new GraphStore(root);
		await store.appendBatch({ nodes: [node("n_A")], chains: [], coverage: [] });
		await writeFile(
			store.nodesPath,
			`${await readFile(store.nodesPath, "utf8")}{oops\n{"id":"x"}\n`,
		);
		expect((await store.read()).nodes.map((n) => n.id)).toEqual(["n_A"]);
	});
});

describe("derive", () => {
	test("implications per chain and groups by birth source, largest first", () => {
		const nodes = [
			node("n_A", "s1"),
			node("n_B", "s2"),
			node("n_C", "s2"),
			node("n_D", "s2"),
		];
		const chains = [
			{
				id: "arg_1",
				premises: ["n_A"],
				conclusion: "n_B",
				createdAt: "2026-01-01T00:00:00.000Z",
				sources: [],
			},
			{
				id: "arg_2",
				premises: ["n_A", "n_C"],
				conclusion: "n_D",
				createdAt: "2026-01-01T00:00:00.000Z",
				sources: [],
			},
			{
				id: "arg_3",
				premises: ["n_GONE"],
				conclusion: "n_D",
				createdAt: "2026-01-01T00:00:00.000Z",
				sources: [],
			},
		];
		const snap = deriveSnapshot({ nodes, chains }, { s2: "Channels" });
		expect(snap.implications).toEqual([
			{ id: "arg_1", premises: ["n_A"], conclusion: "n_B" },
			{ id: "arg_2", premises: ["n_A", "n_C"], conclusion: "n_D" },
		]);
		expect(snap.groups).toEqual([
			{ key: "s2", label: "Channels", nodeIds: ["n_B", "n_C", "n_D"] },
			{ key: "s1", label: null, nodeIds: ["n_A"] },
		]);
	});
});

const longMessage = (i: number) =>
	`Message ${i}: a channel ack is the signal that the consumer has processed the message. ${"padding ".repeat(500)}`;

describe("coverage and triggering", () => {
	test("below threshold waits; flush runs; covered messages do not re-run", async () => {
		const llm = new ScriptedLlm([good, good]);
		const service = new GraphServiceImpl({ root, llm, newId: ids });
		const source = { id: "lesson-1", label: "Acks" };
		service.noteProse(source, [{ id: "m1", text: "short prose" }]);
		await service.idle();
		expect(llm.calls).toHaveLength(0);
		expect(service.pendingCount("lesson-1")).toBe(1);
		service.noteProse(source, [], { flush: true });
		await service.idle();
		expect(llm.calls).toHaveLength(1);
		service.noteProse(source, [{ id: "m1", text: "short prose" }], {
			flush: true,
		});
		await service.idle();
		expect(llm.calls).toHaveLength(1);
		// Coverage survives a restart.
		const fresh = new GraphServiceImpl({ root, llm, newId: ids });
		fresh.noteProse(source, [{ id: "m1", text: "short prose" }], {
			flush: true,
		});
		await fresh.idle();
		expect(llm.calls).toHaveLength(1);
	});

	test("4000 uncovered tokens trigger a run without flush", async () => {
		const llm = new ScriptedLlm([good]);
		const service = new GraphServiceImpl({ root, llm, newId: ids });
		const source = { id: "lesson-1", label: "Acks" };
		const messages = [1, 2, 3, 4, 5].map((i) => ({
			id: `m${i}`,
			text: longMessage(i),
		}));
		service.noteProse(source, messages.slice(0, 2));
		await service.idle();
		expect(llm.calls).toHaveLength(0);
		service.noteProse(source, messages);
		await service.idle();
		expect(llm.calls).toHaveLength(1);
		expect((await service.store.coverage()).length).toBe(5);
	});

	test("privacy: indexIntoGraph=false and local_only with cloud llm skip", async () => {
		const llm = new ScriptedLlm([good], true);
		const privacy: PrivacyGate = {
			isLocalOnly: () => false,
			allowCloud: () => true,
			redact: (t) => t,
			indexIntoGraph: (path) => path !== "blocked",
		};
		const service = new GraphServiceImpl({ root, llm, privacy: () => privacy });
		service.noteProse({ id: "blocked", label: "b" }, [{ id: "m", text: "x" }], {
			flush: true,
		});
		service.noteProse(
			{ id: "private", label: "p", localOnly: true },
			[{ id: "m", text: "x" }],
			{
				flush: true,
			},
		);
		await service.idle();
		expect(llm.calls).toHaveLength(0);
	});

	test("activity job, graph_changed, and failed run checkpoints nothing", async () => {
		const jobs: string[] = [];
		const activity = new ActivityRegistry((list) => {
			for (const job of list)
				jobs.push(`${job.kind}:${job.label}:${job.status}`);
		});
		const sent: DaemonMessage[] = [];
		const llm = new ScriptedLlm(["{}", "{}", "{}", good]);
		const service = new GraphServiceImpl({
			root,
			llm,
			activity,
			broadcast: (m) => sent.push(m),
		});
		const source = { id: "lesson-1", label: "Acks" };
		service.noteProse(source, [{ id: "m1", text: "prose" }], { flush: true });
		await service.idle();
		expect(jobs).toContain("extraction:Extracting: Acks:error");
		expect(sent).toHaveLength(0);
		expect(await ledgerText()).toBe("");
		service.noteProse(source, [{ id: "m1", text: "prose" }], { flush: true });
		await service.idle();
		expect(jobs).toContain("extraction:Extracting: Acks:done");
		expect(sent).toEqual([{ type: "graph_changed" }]);
	});

	test("batches within a source are serial; at most 2 sources run at once", async () => {
		let active = 0;
		let peak = 0;
		const perSource = new Map<string, number>();
		const llm: LlmPort = {
			isCloud: false,
			async *stream() {},
			async complete(req) {
				if (req.system.startsWith("You audit")) return '{"links":[]}';
				const key = req.messages[0]?.content.includes("src-a") ? "a" : "other";
				active++;
				peak = Math.max(peak, active);
				perSource.set(key, (perSource.get(key) ?? 0) + 1);
				expect(perSource.get("a") ?? 0).toBeLessThanOrEqual(1);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				perSource.set(key, (perSource.get(key) ?? 1) - 1);
				return good;
			},
		};
		const service = new GraphServiceImpl({ root, llm });
		for (const id of ["a", "b", "c"]) {
			service.noteProse(
				{ id, label: id },
				[{ id: "m1", text: `src-${id} one` }],
				{ flush: true },
			);
			service.noteProse(
				{ id, label: id },
				[{ id: "m2", text: `src-${id} two` }],
				{ flush: true },
			);
		}
		await service.idle();
		expect(peak).toBe(2);
		const snap = await service.snapshot();
		expect(snap.groups.map((g) => g.label).sort()).toEqual(["a", "b", "c"]);
	});

	test("fake mode heuristic fills the graph without a model", async () => {
		const llm = new ScriptedLlm([]);
		const service = new GraphServiceImpl({ root, llm, fake: true });
		service.noteProse(
			{ id: "lesson-1", label: "Channels" },
			[
				{
					id: "m1",
					text: "Hi there. A channel ack is the signal that a message was processed. Unacked messages are redelivered to another consumer later. Short one.",
				},
			],
			{ flush: true },
		);
		await service.idle();
		expect(llm.calls).toHaveLength(0);
		const snap = await service.snapshot();
		expect(snap.nodes).toHaveLength(2);
		expect(snap.chains).toHaveLength(1);
		expect(snap.groups[0]).toMatchObject({
			key: "lesson-1",
			label: "Channels",
		});
	});

	test("heuristic references statements already in the graph", () => {
		const existing = {
			...node("n_X"),
			statement: "A channel ack is the signal that a message was processed.",
		};
		const submit = heuristicExtract(
			[
				{
					id: "m",
					text: `${existing.statement} Unacked messages are redelivered to another consumer later.`,
				},
			],
			{
				nodes: [existing],
				chains: [],
				byId: new Map([["n_X", existing]]),
				tombstoned: new Set(),
			},
		);
		expect(submit.propositions).toHaveLength(1);
		expect(submit.chains).toEqual([{ premises: ["n_X"], conclusion: "p1" }]);
	});
});

describe("service queries and tools", () => {
	test("search, recent, get, list_propositions", async () => {
		const store = new GraphStore(root);
		await store.appendBatch({
			nodes: [
				{
					...node("n_A", "s", "Channel ack"),
					statement: "An ack tells the broker a message is done.",
					createdAt: "2026-01-01T00:00:00Z",
				},
				{
					...node("n_B", "s", "Prefetch limit"),
					aliases: ["qos"],
					statement: "Prefetch caps unacked messages.",
					createdAt: "2026-01-02T00:00:00Z",
				},
			],
			chains: [],
			coverage: [],
		});
		const service = new GraphServiceImpl({ root, llm: new ScriptedLlm([]) });
		expect((await service.search("ack")).map((n) => n.id)[0]).toBe("n_A");
		expect((await service.search("qos")).map((n) => n.id)).toEqual(["n_B"]);
		expect((await service.recent(1)).map((n) => n.id)).toEqual(["n_B"]);
		expect((await service.get("n_A"))?.name).toBe("Channel ack");
		const [tool] = graphTools(service);
		expect(tool?.name).toBe("list_propositions");
		expect(await tool?.execute({ query: "prefetch" })).toBe(
			"n_B | Prefetch limit | Prefetch caps unacked messages.",
		);
		expect((await tool?.execute({}))?.split("\n")).toHaveLength(2);
		expect(await tool?.execute({ query: "zebra" })).toContain(
			"No propositions",
		);
	});
});

describe("feature routes", () => {
	function fakeContext(sent: DaemonMessage[]): DaemonContext {
		const services: Services = {};
		return {
			home: root,
			root,
			fake: true,
			broadcast: (m: DaemonMessage) => sent.push(m),
			ports: { llm: new ScriptedLlm([]), clock: new FakeClock() },
			activity: new ActivityRegistry(),
			services,
		} as unknown as DaemonContext;
	}

	test("GET /api/graph and DELETE /api/graph/nodes/:id", async () => {
		const sent: DaemonMessage[] = [];
		const context = fakeContext(sent);
		const feature = createGraphFeature(context);
		expect(context.services.graph).toBe(feature.service);
		await feature.service.store.appendBatch({
			nodes: [node("n_A"), node("n_B")],
			chains: [
				{
					id: chainId(["n_A"], "n_B"),
					premises: ["n_A"],
					conclusion: "n_B",
					createdAt: "2026-01-01T00:00:00.000Z",
					sources: [],
				},
			],
			coverage: [],
		});
		const call = async (method: string, path: string) => {
			const url = new URL(`http://127.0.0.1${path}`);
			return feature.route?.(new Request(url, { method }), url, {
				"x-cors": "1",
			});
		};
		const get = await call("GET", "/api/graph");
		expect(get?.status).toBe(200);
		expect(get?.headers.get("x-cors")).toBe("1");
		const snap = await get?.json();
		expect(snap.nodes).toHaveLength(2);
		expect(snap.implications).toHaveLength(1);

		const del = await call("DELETE", "/api/graph/nodes/n_A");
		expect(await del?.json()).toEqual({
			deleted: "n_A",
			chainsRemoved: [chainId(["n_A"], "n_B")],
		});
		expect(sent).toEqual([{ type: "graph_changed" }]);
		const after = await (await call("GET", "/api/graph"))?.json();
		expect(after.chains).toHaveLength(0);

		expect((await call("DELETE", "/api/graph/nodes/n_A"))?.status).toBe(404);
		expect(await call("GET", "/api/lessons")).toBeUndefined();
		expect(await call("POST", "/api/graph")).toBeUndefined();
	});
});

test("auditor read tools resolve identity and preserve source provenance", async () => {
	const store = new GraphStore(root);
	await store.appendBatch({
		nodes: [node("n_ACK", "other", "Ack confirms delivery")],
		chains: [],
		coverage: [],
	});
	const llm = new ScriptedLlm([
		good,
		JSON.stringify({
			calls: [
				{ tool: "find", text: "ack" },
				{ tool: "list_propositions", sourceId: "other" },
			],
		}),
		(req) => {
			expect(req.messages.at(-1)?.content).toContain("n_ACK");
			return JSON.stringify({ links: [{ newId: "p1", existingId: "n_ACK" }] });
		},
	]);
	await runExtraction(
		{ store, llm },
		{
			id: "lesson-new",
			label: "lesson",
			refs: [{ kind: "file", path: "/project/consumer.ts" }],
		},
		[{ id: "m", text: "An ack confirms delivery." }],
	);
	const state = await store.read();
	expect(state.byId.get("n_ACK")?.sources).toContainEqual({
		kind: "file",
		path: "/project/consumer.ts",
	});
});

test("derived view prunes old chains when a later stronger argument arrives", () => {
	const nodes = [node("n_A"), node("n_B"), node("n_X")];
	const chain = (premises: string[]) => ({
		id: chainId(premises, "n_X"),
		premises,
		conclusion: "n_X",
		createdAt: new Date(0).toISOString(),
		sources: [],
	});
	const old = chain(["n_A", "n_B"]),
		strong = chain(["n_A"]);
	const snapshot = deriveSnapshot({ nodes, chains: [old, strong] });
	expect(snapshot.chains).toEqual([strong]);
});

test("repeated claims retain both session sources for across-session discovery", async () => {
	const graph = new GraphServiceImpl({
		root,
		llm: new ScriptedLlm([]),
		fake: true,
	});
	const text =
		"An acknowledgement confirms that the consumer handled the message.";
	graph.noteProse(
		{ id: "/watched/session-one.jsonl", label: "first" },
		[{ id: "m1", text }],
		{ flush: true },
	);
	await graph.idle();
	graph.noteProse(
		{ id: "/watched/session-two.jsonl", label: "second" },
		[{ id: "m2", text }],
		{ flush: true },
	);
	await graph.idle();
	const snapshot = await graph.snapshot();
	expect(snapshot.nodes).toHaveLength(1);
	expect(
		snapshot.nodes[0]?.sources
			.filter((ref) => ref.kind === "session")
			.map((ref) => ref.file),
	).toEqual(["/watched/session-one.jsonl", "/watched/session-two.jsonl"]);
});
