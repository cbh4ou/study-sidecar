import { useEffect, useRef, useState } from "react";
import type { GraphSnapshot } from "../lib/protocol";
export function ChainTable({
	graph,
	onClose,
}: {
	graph: GraphSnapshot;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const [search, setSearch] = useState("");
	const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const chains = graph.chains.filter((c) =>
		[...c.premises, c.conclusion].some((id) =>
			(names.get(id) ?? id).toLowerCase().includes(search.toLowerCase()),
		),
	);
	return (
		<dialog
			ref={dialog}
			className="chain-overlay"
			aria-label="Reasoning chains"
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			<header className="page-heading">
				<h2>Reasoning chains</h2>
				<button type="button" onClick={onClose}>
					Close
				</button>
			</header>
			<label>
				Search chains
				<input value={search} onChange={(e) => setSearch(e.target.value)} />
			</label>
			<table>
				<thead>
					<tr>
						<th>Premises</th>
						<th>Conclusion</th>
						<th>Sources</th>
					</tr>
				</thead>
				<tbody>
					{chains.map((c) => (
						<tr key={c.id}>
							<td>{c.premises.map((id) => names.get(id) ?? id).join(" + ")}</td>
							<td>{names.get(c.conclusion)}</td>
							<td>{c.sources.length}</td>
						</tr>
					))}
				</tbody>
			</table>
			{!chains.length && <p>No matching chains.</p>}
		</dialog>
	);
}
