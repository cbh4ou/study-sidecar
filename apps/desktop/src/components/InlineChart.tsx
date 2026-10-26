export type Chart = {
	title?: string;
	points: Array<{ step: number; value: number }>;
};
export function parseChart(text: string): Chart | undefined {
	try {
		const value = JSON.parse(text);
		if (
			!value ||
			!Array.isArray(value.points) ||
			!value.points.length ||
			value.points.length > 200 ||
			!value.points.every(
				(p: unknown) =>
					typeof p === "object" &&
					p !== null &&
					"step" in p &&
					"value" in p &&
					typeof p.step === "number" &&
					Number.isFinite(p.step) &&
					typeof p.value === "number" &&
					Number.isFinite(p.value),
			)
		)
			return undefined;
		return {
			title: typeof value.title === "string" ? value.title : undefined,
			points: value.points,
		};
	} catch {
		return undefined;
	}
}
export function InlineChart({ chart }: { chart: Chart }) {
	const xs = chart.points.map((p) => p.step),
		ys = chart.points.map((p) => p.value),
		minX = Math.min(...xs),
		maxX = Math.max(...xs),
		minY = Math.min(...ys),
		maxY = Math.max(...ys);
	const points = chart.points
		.map(
			(p) =>
				`${35 + ((p.step - minX) / (maxX - minX || 1)) * 500},${215 - ((p.value - minY) / (maxY - minY || 1)) * 185}`,
		)
		.join(" ");
	return (
		<figure className="inline-chart">
			<figcaption>{chart.title ?? "Run metric"}</figcaption>
			<svg
				viewBox="0 0 560 250"
				role="img"
				aria-label={`${chart.title ?? "Run metric"}, ${chart.points.length} points`}
			>
				<path d="M35 20 V215 H540" fill="none" stroke="#637a90" />
				<polyline
					points={points}
					fill="none"
					stroke="#8bb9f0"
					strokeWidth="2"
				/>
				<text x="35" y="240" fill="currentColor">
					{minX}
				</text>
				<text x="510" y="240" fill="currentColor">
					{maxX}
				</text>
				<text x="0" y="25" fill="currentColor">
					{Number(maxY.toPrecision(3))}
				</text>
			</svg>
			<details>
				<summary>Data points</summary>
				<table>
					<thead>
						<tr>
							<th>Step</th>
							<th>Value</th>
						</tr>
					</thead>
					<tbody>
						{chart.points.map((p) => (
							<tr key={`${p.step}-${p.value}`}>
								<td>{p.step}</td>
								<td>{p.value}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}
