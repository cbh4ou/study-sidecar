import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { GRAPH_GROUP_COLORS, GraphCanvas } from "../components/GraphCanvas";
import { useDeleteNode, useGraph } from "../lib/api";
import { ChainTable } from "./ChainTable";
export function GraphHome() {
	const { data: graph, isPending, error } = useGraph();
	const remove = useDeleteNode();
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState("");
	const [chains, setChains] = useState(false);
	const select = useCallback((id: string) => setSelected(id), []);
	if (isPending) return <p>Loading your graph…</p>;
	if (error) return <p role="alert">{error.message}</p>;
	if (!graph) return null;
	const node = graph.nodes.find((n) => n.id === selected);
	return (
		<section>
			<header className="page-heading">
				<div>
					<h1>Knowledge graph</h1>
					<p>Claims and the reasoning that connects them.</p>
				</div>
				<button type="button" onClick={() => setChains(true)}>
					Chains ({graph.chains.length})
				</button>
			</header>
			<label>
				Find a proposition
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</label>
			{!graph.nodes.length ? (
				<div className="empty-state">
					<h2>Your graph starts with a lesson</h2>
					<p>
						Explore a topic. The tutor extracts grounded claims as you learn.
					</p>
					<Link to="/classroom">Start a lesson</Link>
				</div>
			) : (
				<>
					<section className="graph-legend" aria-label="Birth source groups">
						{graph.groups.map((g, i) => (
							<span
								key={g.key}
								style={{
									color: GRAPH_GROUP_COLORS[i % GRAPH_GROUP_COLORS.length],
								}}
							>
								{g.label ?? g.key}
							</span>
						))}
					</section>
					<GraphCanvas graph={graph} search={search} onSelect={select} />
					<details>
						<summary>Proposition list</summary>
						{graph.nodes
							.filter((n) =>
								n.name.toLowerCase().includes(search.toLowerCase()),
							)
							.map((n) => (
								<button type="button" key={n.id} onClick={() => select(n.id)}>
									{n.name}
								</button>
							))}
					</details>
					{node && (
						<aside className="node-inspector">
							<h2>{node.name}</h2>
							<p>{node.statement}</p>
							<p>{node.sources.length} sources</p>
							<button
								type="button"
								onClick={() =>
									remove.mutate(node.id, { onSuccess: () => setSelected("") })
								}
							>
								Delete proposition
							</button>
							{remove.error && <p role="alert">{remove.error.message}</p>}
						</aside>
					)}
				</>
			)}
			{chains && <ChainTable graph={graph} onClose={() => setChains(false)} />}
		</section>
	);
}
