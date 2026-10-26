import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	useCreateLesson,
	useSessionDetail,
	useSessions,
	useUpdateSource,
} from "../lib/api";
import { daemonRequest, useHudMessages } from "../lib/ws";
import { sourceLabel } from "./Classroom";
export function Sessions({
	picker = false,
	onPick,
}: {
	picker?: boolean;
	onPick?: () => void;
}) {
	const { data, error } = useSessions();
	const [selected, setSelected] = useState<string>();
	const { data: detail } = useSessionDetail(
		selected ?? data?.bound ?? undefined,
	);
	const update = useUpdateSource();
	const create = useCreateLesson();
	const navigate = useNavigate();
	const { send } = useHudMessages();
	return (
		<section>
			<header className="page-heading">
				<h1>Sessions</h1>
				<button
					type="button"
					onClick={() => {
						send({ type: "bind_session", sessionPath: null });
						onPick?.();
					}}
				>
					Follow active
				</button>
			</header>
			{error && <p role="alert">{error.message}</p>}
			<div className="sessions-columns">
				<div className="session-list">
					{data?.sessions.map((s) => (
						<button
							type="button"
							key={s.path}
							className={`session-row ${selected === s.path ? "selected" : ""}`}
							onClick={() => {
								setSelected(s.path);
								if (picker) {
									send({ type: "bind_session", sessionPath: s.path });
									onPick?.();
								}
							}}
						>
							<strong>{s.project ?? s.path.split("/").at(-1)}</strong>
							<span>
								{s.harness} / {s.live ? "live" : "idle"}
								{s.localOnly ? " / local only" : ""}
							</span>
							<small>
								{s.noteCount} tutor notes {s.bound ? "/ bound" : ""}
							</small>
						</button>
					))}
					{!data?.sessions.length && <p>No watched sessions yet.</p>}
				</div>
				{detail && !picker && (
					<article className="session-detail">
						<h2>{detail.summary.project ?? "Session detail"}</h2>
						<label>
							<input
								type="checkbox"
								checked={detail.summary.localOnly}
								onChange={(e) =>
									update.mutate({
										path: detail.summary.path,
										local_only: e.target.checked,
									})
								}
							/>
							Local only
						</label>
						<label>
							<input
								type="checkbox"
								checked={detail.summary.indexGraph}
								onChange={(e) =>
									update.mutate({
										path: detail.summary.path,
										index_graph: e.target.checked,
									})
								}
							/>
							Index into graph
						</label>
						<div className="action-row">
							<button
								type="button"
								onClick={() =>
									send({
										type: "bind_session",
										sessionPath: detail.summary.path,
									})
								}
							>
								Bind pill
							</button>
							<button
								type="button"
								onClick={() =>
									create.mutate(
										{
											goal: `Understand ${detail.summary.project ?? "this session"}`,
											sessionPath: detail.summary.path,
										},
										{
											onSuccess: ({ lesson }) =>
												void navigate({
													to: "/classroom/$lessonId",
													params: { lessonId: lesson.id },
												}),
										},
									)
								}
							>
								Start lesson from session
							</button>
							<button
								type="button"
								onClick={() =>
									void daemonRequest("/api/recap", { method: "POST", body: {} })
								}
							>
								Session recap
							</button>
						</div>
						<h3>Recent receipts</h3>
						{detail.receipts.slice(-20).map((r) => (
							<p key={`${r.at}-${r.text}`}>{r.text}</p>
						))}
						<h3>Agent notes</h3>
						{detail.notes.map((n) => (
							<p key={`${n.at}-${n.concept}`}>
								{n.concept}: {n.why}
							</p>
						))}
						<h3>Concepts touched</h3>
						<ul>
							{detail.concepts.map((c) => (
								<li key={c.id}>{c.name}</li>
							))}
						</ul>
						<h3>Pinned anchors</h3>
						<ul>
							{detail.anchors.map((a) => (
								<li key={JSON.stringify(a)}>{sourceLabel(a)}</li>
							))}
						</ul>
					</article>
				)}
			</div>
			{!picker && (
				<aside className="across-sessions">
					<h2>Across sessions</h2>
					{data?.acrossSessions.length ? (
						data.acrossSessions.map((n) => (
							<p key={n.id}>
								{n.name} <small>{n.sessions.length} sessions</small>
							</p>
						))
					) : (
						<p>Shared propositions appear here when they span two sessions.</p>
					)}
				</aside>
			)}
		</section>
	);
}
