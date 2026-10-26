import type { PlanStatus } from "../protocol.ts";

/**
 * Lesson plan: a prerequisite DAG authored once as a small Mermaid
 * flowchart subset (spec Section 16). Statuses are always derived from
 * tagged quiz answers, never stored.
 */

export type PlanNode = { id: string; label: string };
export type PlanEdge = { from: string; to: string; line: number };
export type Plan = { nodes: PlanNode[]; edges: PlanEdge[] };
export type PlanParseResult =
	| ({ ok: true } & Plan)
	| { ok: false; errors: string[] };

const HEADER = /^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\s*;?$/i;
const NODE =
	/^([A-Za-z_][\w-]*)(?:\[\s*"?([^\]"]*)"?\s*\]|\(\s*"?([^)"]*)"?\s*\))?$/;

function stripComment(line: string): string {
	const at = line.indexOf("%%");
	return (at === -1 ? line : line.slice(0, at)).trim();
}

function parseNode(token: string): { id: string; label?: string } | undefined {
	const match = NODE.exec(token.trim());
	if (!match?.[1]) return undefined;
	const label = (match[2] ?? match[3])?.trim();
	return { id: match[1], label: label || undefined };
}

/** Parse and validate a plan. Errors are line-numbered (1-based). */
export function planInit(mermaid: string): PlanParseResult {
	const lines = mermaid.split(/\r?\n/);
	const errors: string[] = [];
	const nodes = new Map<string, PlanNode>();
	const edges: PlanEdge[] = [];
	const seenEdges = new Set<string>();
	let headerSeen = false;

	const declare = (node: { id: string; label?: string }) => {
		const existing = nodes.get(node.id);
		if (!existing)
			nodes.set(node.id, { id: node.id, label: node.label ?? node.id });
		else if (node.label) existing.label = node.label;
	};

	lines.forEach((raw, index) => {
		const lineNo = index + 1;
		const line = stripComment(raw).replace(/;\s*$/, "").trim();
		if (!line) return;
		if (!headerSeen) {
			if (HEADER.test(line)) {
				headerSeen = true;
				return;
			}
			errors.push(
				`line ${lineNo}: expected a "flowchart TD" or "graph LR" header`,
			);
			headerSeen = true;
			return;
		}
		if (HEADER.test(line)) {
			errors.push(`line ${lineNo}: duplicate header`);
			return;
		}
		const segments = line.split("-->");
		const groups: Array<Array<{ id: string; label?: string }>> = [];
		for (const segment of segments) {
			const group: Array<{ id: string; label?: string }> = [];
			for (const token of segment.split("&")) {
				const node = parseNode(token);
				if (!node) {
					errors.push(`line ${lineNo}: unknown syntax`);
					return;
				}
				group.push(node);
			}
			groups.push(group);
		}
		for (const group of groups) for (const node of group) declare(node);
		for (let i = 0; i + 1 < groups.length; i++) {
			for (const from of groups[i] ?? []) {
				for (const to of groups[i + 1] ?? []) {
					if (from.id === to.id) {
						errors.push(`line ${lineNo}: cycle ${from.id} -> ${to.id}`);
						continue;
					}
					const key = `${from.id}\u0000${to.id}`;
					if (seenEdges.has(key)) continue;
					seenEdges.add(key);
					edges.push({ from: from.id, to: to.id, line: lineNo });
				}
			}
		}
	});

	if (!headerSeen)
		errors.push('line 1: expected a "flowchart TD" or "graph LR" header');
	if (errors.length === 0 && nodes.size === 0)
		errors.push("line 1: plan has no nodes");
	if (errors.length === 0) {
		const cycle = findCycle([...nodes.keys()], edges);
		if (cycle) errors.push(cycle);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, nodes: [...nodes.values()], edges };
}

function findCycle(ids: string[], edges: PlanEdge[]): string | undefined {
	const out = new Map<string, PlanEdge[]>();
	for (const edge of edges) {
		const list = out.get(edge.from) ?? [];
		list.push(edge);
		out.set(edge.from, list);
	}
	const state = new Map<string, 1 | 2>();
	const stack: string[] = [];
	const visit = (id: string): string | undefined => {
		state.set(id, 1);
		stack.push(id);
		for (const edge of out.get(id) ?? []) {
			const mark = state.get(edge.to);
			if (mark === 1) {
				const path = [...stack.slice(stack.indexOf(edge.to)), edge.to];
				return `line ${edge.line}: cycle ${path.join(" -> ")}`;
			}
			if (mark === undefined) {
				const found = visit(edge.to);
				if (found) return found;
			}
		}
		stack.pop();
		state.set(id, 2);
		return undefined;
	};
	for (const id of ids) {
		if (state.has(id)) continue;
		const found = visit(id);
		if (found) return found;
	}
	return undefined;
}

/** Stable topological order (Kahn, ties broken by declaration order). */
export function topoOrder(nodes: PlanNode[], edges: PlanEdge[]): string[] {
	const indegree = new Map(nodes.map((node) => [node.id, 0]));
	for (const edge of edges)
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	const order: string[] = [];
	const done = new Set<string>();
	while (order.length < nodes.length) {
		const next = nodes.find(
			(node) => !done.has(node.id) && (indegree.get(node.id) ?? 0) === 0,
		);
		if (!next) break;
		done.add(next.id);
		order.push(next.id);
		for (const edge of edges)
			if (edge.from === next.id)
				indegree.set(edge.to, (indegree.get(edge.to) ?? 0) - 1);
	}
	return order;
}

/**
 * A node is visited once a quiz tagged with it was answered correctly; the
 * current node is the first unvisited node (topological order) whose
 * prerequisites are all visited; everything else is upcoming.
 */
export function derivePlanStatuses(
	nodes: PlanNode[],
	edges: PlanEdge[],
	answers: Array<{ planNode?: string; correct?: boolean }>,
): Array<{ id: string; label: string; status: PlanStatus }> {
	const visited = new Set(
		answers
			.filter((answer) => answer.correct === true && answer.planNode)
			.map((answer) => answer.planNode as string),
	);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	let current: string | undefined;
	for (const id of topoOrder(nodes, edges)) {
		if (visited.has(id)) continue;
		const prereqs = edges.filter((edge) => edge.to === id);
		if (prereqs.every((edge) => visited.has(edge.from))) {
			current = id;
			break;
		}
	}
	return topoOrder(nodes, edges).map((id) => ({
		id,
		label: byId.get(id)?.label ?? id,
		status: visited.has(id)
			? "visited"
			: id === current
				? "current"
				: "upcoming",
	}));
}
