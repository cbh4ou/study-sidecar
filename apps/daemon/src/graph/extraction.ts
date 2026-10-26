import { z } from "zod";
import type { LlmMessage, LlmPort } from "../ports/llm.ts";
import type { Proposition, SourceRef } from "../protocol.ts";
import type { PrivacyGate } from "../services.ts";
import { redact } from "../tutor/redact.ts";
import {
	type AuditorSubmit,
	AuditorSubmitSchema,
	type ExtractorSubmit,
	ExtractorSubmitSchema,
	formatIssues,
} from "./contracts.ts";
import { type MergePlan, merge, sourceChains } from "./merger.ts";
import { privateProposition, sourcePath } from "./privacy.ts";
import { rankNodes } from "./search.ts";
import type { GraphState, GraphStore } from "./store.ts";

export type ExtractionSource = {
	id: string;
	label: string;
	localOnly?: boolean;
	refs?: SourceRef[];
};
export type ProseMessage = { id: string; text: string };

export type ExtractionDeps = {
	store: GraphStore;
	privacy?: PrivacyGate;
	llm: LlmPort;
	/** Deterministic heuristic extractor and no-op auditor (no model). */
	fake?: boolean;
	now?: () => number;
	signal?: AbortSignal;
	/** Applied to every cloud-bound string; defaults to tutor/redact.ts. */
	redact?: (text: string) => string;
	/** Override the provenance attached to the batch (default: lesson refs). */
	refs?: (source: ExtractionSource, batch: ProseMessage[]) => SourceRef[];
	newId?: (now: number) => string;
};

export const MAX_EXTRACTOR_TURNS = 3;
const AUDIT_CANDIDATES = 5;
const AuditCallsSchema = z.object({
	calls: z
		.array(
			z.discriminatedUnion("tool", [
				z.object({ tool: z.literal("find"), text: z.string().min(1) }),
				z.object({
					tool: z.literal("list_propositions"),
					sourceId: z.string().min(1),
				}),
			]),
		)
		.min(1)
		.max(5),
});

export const EXTRACTOR_SYSTEM = `You extract a knowledge graph from tutor prose.
A proposition is one objective, world-facing claim (never about the learner, the lesson, or what was said). Give it a short name (<= 80 chars) and a one-sentence statement.
A chain is a set of premises that JOINTLY entail a conclusion. Two independent arguments for the same conclusion are two chains. Never put the conclusion among its premises.
New propositions use short local ids you choose (p1, p2, ...). Chain endpoints may be your local ids or existing ids (n_...) from GRAPH SO FAR. Do not restate a proposition that already exists; reference its id.
Reply with ONE JSON object and nothing else:
{"propositions":[{"id":"p1","name":"...","statement":"...","aliases":["..."]}],"chains":[{"premises":["p1"],"conclusion":"p2"}]}`;

export const AUDITOR_SYSTEM = `You audit new propositions against an existing knowledge graph.
For each new proposition, decide whether it states the SAME claim as one of its listed candidates (same meaning, possibly different wording). Prefer linking when they are equivalent; never link a claim to a merely related, broader, or narrower one.
You may request read-only tools with {"calls":[{"tool":"find","text":"claim"},{"tool":"list_propositions","sourceId":"source id"}]}. Tool results contain existing propositions only.
When ready reply with ONE JSON object and nothing else:
{"links":[{"newId":"p1","existingId":"n_..."}]}`;

function compact(node: Proposition): string {
	return `${node.id} | ${node.name} | ${node.statement}`;
}

/** "GRAPH SO FAR" for one source: its live propositions and chains, with ids. */
export function graphSoFar(state: GraphState, sourceId: string): string {
	const nodes = state.nodes.filter((n) => n.birthSource === sourceId);
	const chains = sourceChains(state, sourceId);
	const lines = ["GRAPH SO FAR", "Propositions:"];
	lines.push(...(nodes.length ? nodes.map(compact) : ["(none)"]));
	lines.push("Chains:");
	lines.push(
		...(chains.length
			? chains.map(
					(c) => `${c.id}: [${c.premises.join(", ")}] => ${c.conclusion}`,
				)
			: ["(none)"]),
	);
	return lines.join("\n");
}

/** Pull the first JSON object out of a reply (tolerates code fences). */
export function parseJsonReply(reply: string): unknown {
	const trimmed = reply.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start)
			return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error("reply is not JSON");
	}
}

/** Semantic checks zod cannot express (ids resolve, no self-reference). */
export function validateSubmit(
	submit: ExtractorSubmit,
	state: GraphState,
): string | undefined {
	const local = new Set<string>();
	for (const prop of submit.propositions) {
		if (local.has(prop.id)) return `duplicate local id ${prop.id}`;
		if (prop.id.startsWith("n_"))
			return `new proposition id ${prop.id} must be a local id, not n_`;
		local.add(prop.id);
	}
	const known = (id: string) => local.has(id) || state.byId.has(id);
	for (const [index, chain] of submit.chains.entries()) {
		for (const id of [...chain.premises, chain.conclusion]) {
			if (!known(id)) return `chains.${index}: unknown proposition id ${id}`;
		}
		if (chain.premises.includes(chain.conclusion))
			return `chains.${index}: conclusion ${chain.conclusion} is also a premise`;
	}
	return undefined;
}

/** Validate one extractor reply; returns the submit or an error string for the model. */
export function checkExtractorReply(
	reply: string,
	state: GraphState,
): { ok: true; submit: ExtractorSubmit } | { ok: false; error: string } {
	let raw: unknown;
	try {
		raw = parseJsonReply(reply);
	} catch (error) {
		return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
	}
	const parsed = ExtractorSubmitSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
	const semantic = validateSubmit(parsed.data, state);
	if (semantic) return { ok: false, error: semantic };
	return { ok: true, submit: parsed.data };
}

async function llmExtract(
	deps: ExtractionDeps,
	state: GraphState,
	source: ExtractionSource,
	batch: ProseMessage[],
): Promise<ExtractorSubmit> {
	const clean = deps.llm.isCloud ? (deps.redact ?? redact) : (t: string) => t;
	const prose = batch.map((m) => clean(m.text)).join("\n\n");
	const messages: LlmMessage[] = [
		{
			role: "user",
			content: `${clean(graphSoFar(state, source.id))}\n\nTUTOR PROSE\n${prose}`,
		},
	];
	let lastError = "";
	for (let turn = 1; turn <= MAX_EXTRACTOR_TURNS; turn++) {
		if (deps.signal?.aborted) throw new Error("extraction aborted");
		const reply = await deps.llm.complete({
			lane: "deep",
			system: EXTRACTOR_SYSTEM,
			messages,
			json: true,
			signal: deps.signal,
		});
		const checked = checkExtractorReply(reply, state);
		if (checked.ok) return checked.submit;
		lastError = checked.error;
		messages.push(
			{ role: "assistant", content: clean(reply) },
			{
				role: "user",
				content: clean(
					`Submit rejected: ${checked.error}. Fix it and reply with the corrected JSON object only.`,
				),
			},
		);
	}
	throw new Error(
		`extractor failed after ${MAX_EXTRACTOR_TURNS} turns: ${lastError}`,
	);
}

/** Bounded auditor read operations remain deterministic and read-only. */
async function llmAudit(
	deps: ExtractionDeps,
	state: GraphState,
	submit: ExtractorSubmit,
): Promise<AuditorSubmit["links"]> {
	if (!submit.propositions.length || !state.nodes.length) return [];
	const clean = deps.llm.isCloud ? (deps.redact ?? redact) : (t: string) => t;
	const offered = new Map<string, Set<string>>();
	const blocks: string[] = [];
	for (const prop of submit.propositions) {
		const candidates = rankNodes(
			state.nodes,
			`${prop.name} ${(prop.aliases ?? []).join(" ")} ${prop.statement}`,
			AUDIT_CANDIDATES,
		);
		offered.set(prop.id, new Set(candidates.map((c) => c.id)));
		blocks.push(
			[
				`NEW ${prop.id} | ${prop.name} | ${prop.statement}`,
				...candidates.map((c) => `  candidate ${compact(c)}`),
			].join("\n"),
		);
	}
	if (!blocks.length) return [];
	const messages: LlmMessage[] = [
		{ role: "user", content: clean(blocks.join("\n\n")) },
	];
	let lastError = "";
	for (let turn = 1; turn <= MAX_EXTRACTOR_TURNS; turn++) {
		if (deps.signal?.aborted) throw new Error("extraction aborted");
		const reply = await deps.llm.complete({
			lane: "deep",
			system: AUDITOR_SYSTEM,
			messages,
			json: true,
			signal: deps.signal,
		});
		let raw: unknown;
		try {
			raw = parseJsonReply(reply);
		} catch (error) {
			lastError = `invalid JSON: ${(error as Error).message}`;
			messages.push(
				{ role: "assistant", content: clean(reply) },
				{ role: "user", content: `Submit rejected: ${lastError}.` },
			);
			continue;
		}
		const calls = AuditCallsSchema.safeParse(raw);
		if (calls.success) {
			const results = calls.data.calls.map((call) => {
				const nodes =
					call.tool === "find"
						? rankNodes(state.nodes, call.text, 20)
						: state.nodes.filter((node) => node.birthSource === call.sourceId);
				for (const prop of submit.propositions) {
					const ids = offered.get(prop.id) ?? new Set<string>();
					for (const node of nodes) ids.add(node.id);
					offered.set(prop.id, ids);
				}
				return { tool: call.tool, nodes: nodes.slice(0, 50).map(compact) };
			});
			messages.push(
				{ role: "assistant", content: clean(reply) },
				{ role: "user", content: clean(JSON.stringify(results)) },
			);
			continue;
		}
		const parsed = AuditorSubmitSchema.safeParse(raw);
		if (!parsed.success) {
			lastError = formatIssues(parsed.error);
			messages.push(
				{ role: "assistant", content: clean(reply) },
				{ role: "user", content: `Submit rejected: ${lastError}.` },
			);
			continue;
		}
		return parsed.data.links.filter((link) =>
			offered.get(link.newId)?.has(link.existingId),
		);
	}
	throw new Error(
		`auditor failed after ${MAX_EXTRACTOR_TURNS} turns: ${lastError}`,
	);
}

const CLAIM_MARKERS = [
	" is ",
	" are ",
	" causes ",
	" cause ",
	" means ",
	" mean ",
	" requires ",
	" require ",
	" implies ",
	" leads to ",
	" makes ",
	" prevents ",
	" allows ",
	" has ",
	" have ",
];

/**
 * Fake-mode extractor: every sentence of 6+ words containing a claim marker
 * becomes a proposition; consecutive propositions within one message form a
 * chain [previous] -> next. Sentences already in the graph (same statement)
 * are referenced by id instead of minted again.
 */
export function heuristicExtract(
	batch: ProseMessage[],
	state: GraphState,
): ExtractorSubmit {
	const byStatement = new Map(
		state.nodes.map((n) => [n.statement.toLowerCase(), n.id]),
	);
	const propositions: ExtractorSubmit["propositions"] = [];
	const chains: ExtractorSubmit["chains"] = [];
	const localByStatement = new Map<string, string>();
	for (const message of batch) {
		let previous: string | undefined;
		const sentences = message.text
			.replace(/\s+/g, " ")
			.split(/(?<=[.!?])\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const sentence of sentences) {
			const words = sentence.split(" ").filter(Boolean);
			const padded = ` ${sentence.toLowerCase()} `;
			if (words.length < 6) continue;
			if (!CLAIM_MARKERS.some((marker) => padded.includes(marker))) continue;
			const key = sentence.toLowerCase();
			let id = byStatement.get(key) ?? localByStatement.get(key);
			if (!id) {
				id = `p${propositions.length + 1}`;
				localByStatement.set(key, id);
				const name = words
					.slice(0, 8)
					.join(" ")
					.replace(/[.!?,;:]+$/, "");
				propositions.push({ id, name: name.slice(0, 80), statement: sentence });
			}
			if (previous && previous !== id)
				chains.push({ premises: [previous], conclusion: id });
			previous = id;
		}
	}
	return { propositions, chains };
}

function defaultRefs(
	source: ExtractionSource,
	batch: ProseMessage[],
): SourceRef[] {
	const sessionSource = /\.jsonl$/.test(source.id);
	return [
		...(source.refs ?? []),
		...batch.map(
			(m): SourceRef =>
				sessionSource
					? {
							kind: "session",
							harness: "auto",
							sessionId: source.id,
							file: source.id,
							turnId: m.id,
						}
					: { kind: "lesson", lessonId: source.id, messageId: m.id },
		),
	];
}

export type ExtractionResult = MergePlan;

/**
 * One extraction run: extractor -> auditor -> merger. Reads the ledgers
 * once; nothing is written unless every stage succeeds, and then the
 * merger appends the whole batch (nodes, chains, coverage) at once.
 */
export async function runExtraction(
	deps: ExtractionDeps,
	source: ExtractionSource,
	batch: ProseMessage[],
): Promise<ExtractionResult> {
	const state = await deps.store.read();
	if (
		(source.localOnly ||
			deps.privacy?.isLocalOnly(source.id) ||
			source.refs?.some((ref) => deps.privacy?.isLocalOnly(sourcePath(ref)))) &&
		deps.llm.isCloud &&
		!deps.fake
	)
		throw new Error("Source is local only");
	const nodes = deps.llm.isCloud
		? state.nodes.filter((node) => !privateProposition(node, deps.privacy))
		: state.nodes;
	const visible = {
		...state,
		nodes,
		byId: new Map(nodes.map((node) => [node.id, node])),
		chains: state.chains.filter((chain) =>
			[...chain.premises, chain.conclusion].every((id) =>
				nodes.some((node) => node.id === id),
			),
		),
	};
	const submit = deps.fake
		? heuristicExtract(batch, visible)
		: await llmExtract(deps, visible, source, batch);
	const links = deps.fake ? [] : await llmAudit(deps, visible, submit);
	if (deps.signal?.aborted) throw new Error("extraction aborted");
	const plan = await merge(
		deps.store,
		state,
		{
			sourceId: source.id,
			submit,
			links,
			refs: (deps.refs ?? defaultRefs)(source, batch),
			messages: batch,
			now: (deps.now ?? Date.now)(),
			newId: deps.newId,
		},
		deps.signal,
	);
	return plan;
}
