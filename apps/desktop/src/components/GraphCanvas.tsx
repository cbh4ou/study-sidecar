import {
	forceCenter,
	forceLink,
	forceManyBody,
	forceSimulation,
	type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { useEffect, useRef } from "react";
import type { GraphSnapshot } from "../lib/protocol";
export const GRAPH_GROUP_COLORS = [
	"#8bb9f0",
	"#a6d5bb",
	"#d6b886",
	"#b6a2df",
	"#d992aa",
];
type Node = SimulationNodeDatum & {
	id: string;
	label: string;
	diamond: boolean;
	group: number;
};
export function GraphCanvas({
	graph,
	search,
	onSelect,
}: {
	graph: GraphSnapshot;
	search: string;
	onSelect: (id: string) => void;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		let width = canvas.clientWidth,
			height = canvas.clientHeight;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = width * ratio;
		canvas.height = height * ratio;
		const nodes: Node[] = [
			...graph.nodes.map((n) => ({
				id: n.id,
				label: n.name,
				diamond: false,
				group: Math.max(
					0,
					graph.groups.findIndex((g) => g.key === n.birthSource),
				),
			})),
			...graph.implications.map((n) => ({
				id: n.id,
				label: "",
				diamond: true,
				group: 0,
			})),
		];
		const links: Array<{ source: string | Node; target: string | Node }> =
			graph.implications.flatMap((c) => [
				...c.premises.map((id) => ({ source: id, target: c.id })),
				{ source: c.id, target: c.conclusion },
			]);
		let transform = zoomIdentity;
		const sim = forceSimulation(nodes)
			.force(
				"link",
				forceLink<Node, { source: string | Node; target: string | Node }>(links)
					.id((n) => n.id)
					.distance(115),
			)
			.force("charge", forceManyBody().strength(-250))
			.force("center", forceCenter(width / 2, height / 2));
		const draw = () => {
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
			ctx.clearRect(0, 0, width, height);
			ctx.save();
			ctx.translate(transform.x, transform.y);
			ctx.scale(transform.k, transform.k);
			ctx.lineWidth = 1;
			ctx.strokeStyle = "#536a80";
			for (const l of links) {
				if (typeof l.source === "string" || typeof l.target === "string")
					continue;
				const a = l.source,
					b = l.target;
				const angle = Math.atan2(
					(b.y ?? 0) - (a.y ?? 0),
					(b.x ?? 0) - (a.x ?? 0),
				);
				const endX = (b.x ?? 0) - Math.cos(angle) * 13,
					endY = (b.y ?? 0) - Math.sin(angle) * 13;
				ctx.beginPath();
				ctx.moveTo(a.x ?? 0, a.y ?? 0);
				ctx.lineTo(endX, endY);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(endX, endY);
				ctx.lineTo(
					endX - 7 * Math.cos(angle - 0.45),
					endY - 7 * Math.sin(angle - 0.45),
				);
				ctx.moveTo(endX, endY);
				ctx.lineTo(
					endX - 7 * Math.cos(angle + 0.45),
					endY - 7 * Math.sin(angle + 0.45),
				);
				ctx.stroke();
			}
			for (const n of nodes) {
				const match =
					!search || n.label.toLowerCase().includes(search.toLowerCase());
				ctx.globalAlpha = match ? 1 : 0.22;
				ctx.fillStyle = n.diamond
					? "#64798d"
					: (GRAPH_GROUP_COLORS[n.group % GRAPH_GROUP_COLORS.length] ??
						"#8bb9f0");
				ctx.beginPath();
				if (n.diamond) {
					ctx.moveTo(n.x ?? 0, (n.y ?? 0) - 8);
					ctx.lineTo((n.x ?? 0) + 8, n.y ?? 0);
					ctx.lineTo(n.x ?? 0, (n.y ?? 0) + 8);
					ctx.lineTo((n.x ?? 0) - 8, n.y ?? 0);
					ctx.closePath();
				} else ctx.arc(n.x ?? 0, n.y ?? 0, 10, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = "#dce7f2";
				ctx.font = "12px system-ui";
				ctx.textAlign = "center";
				ctx.fillText(n.label, n.x ?? 0, (n.y ?? 0) + 27, 180);
			}
			ctx.restore();
			ctx.globalAlpha = 1;
		};
		sim.on("tick", draw);
		const selection = select(canvas);
		const behavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.25, 4])
			.on("zoom", (e) => {
				transform = e.transform;
				draw();
			});
		selection.call(behavior);
		const click = (e: MouseEvent) => {
			const box = canvas.getBoundingClientRect();
			const [x, y] = transform.invert([
				e.clientX - box.left,
				e.clientY - box.top,
			]);
			const hit = nodes.find(
				(n) => !n.diamond && Math.hypot((n.x ?? 0) - x, (n.y ?? 0) - y) < 20,
			);
			if (hit) onSelect(hit.id);
		};
		canvas.addEventListener("click", click);
		const observer = new ResizeObserver(() => {
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = width * ratio;
			canvas.height = height * ratio;
			sim
				.force("center", forceCenter(width / 2, height / 2))
				.alpha(0.3)
				.restart();
			draw();
		});
		observer.observe(canvas);
		return () => {
			sim.stop();
			selection.on(".zoom", null);
			canvas.removeEventListener("click", click);
			observer.disconnect();
		};
	}, [graph, search, onSelect]);
	return (
		<canvas
			ref={ref}
			className="graph-canvas"
			role="img"
			aria-label="Proposition graph. Circles are claims, diamonds are implications. Use the proposition list to inspect nodes with the keyboard."
		/>
	);
}
