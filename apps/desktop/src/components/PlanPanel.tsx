import type { LessonDetail } from "../lib/protocol";
import { MermaidView } from "./ui/mermaid-view";
export function PlanPanel({
	lesson,
	contributions,
}: {
	lesson: LessonDetail;
	contributions: number;
}) {
	return (
		<aside className="plan-panel">
			<h2>Plan</h2>
			{lesson.planMermaid ? (
				<MermaidView diagram={lesson.planMermaid} />
			) : (
				<p>The plan follows your prerequisite checks.</p>
			)}
			<ol>
				{lesson.planNodes.map((n) => (
					<li
						key={n.id}
						aria-current={n.status === "current" ? "step" : undefined}
					>
						<span>{n.label}</span>
						<small>{n.status}</small>
					</li>
				))}
			</ol>
			<h3>Queued prerequisites</h3>
			{lesson.queuedGaps.length ? (
				<ul>
					{lesson.queuedGaps.map((g) => (
						<li key={g}>{g}</li>
					))}
				</ul>
			) : (
				<p>No queued gaps.</p>
			)}
			<p>{contributions} graph contributions</p>
		</aside>
	);
}
