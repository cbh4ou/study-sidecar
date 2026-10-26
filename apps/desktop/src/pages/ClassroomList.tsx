import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateLesson, useLessons } from "../lib/api";
import { useHudMessages } from "../lib/ws";
export function ClassroomList() {
	const { data, error, isPending } = useLessons();
	const create = useCreateLesson();
	const navigate = useNavigate();
	const [goal, setGoal] = useState("");
	const { state } = useHudMessages();
	const start = (anchored = false) => {
		if (!goal.trim()) return;
		create.mutate(
			{
				goal: goal.trim(),
				...(anchored && state.anchor ? { anchors: [state.anchor.source] } : {}),
			},
			{
				onSuccess: ({ lesson }) =>
					void navigate({
						to: "/classroom/$lessonId",
						params: { lessonId: lesson.id },
					}),
			},
		);
	};
	return (
		<section>
			<header className="page-heading">
				<div>
					<h1>Classroom</h1>
					<p>
						Measure what you know. Build a plan. Learn one concept at a time.
					</p>
				</div>
			</header>
			<form
				className="new-lesson"
				onSubmit={(e) => {
					e.preventDefault();
					start();
				}}
			>
				<label>
					What do you want to understand?
					<input
						value={goal}
						onChange={(e) => setGoal(e.target.value)}
						maxLength={500}
						required
						placeholder="Why channel acknowledgements matter"
					/>
				</label>
				<button type="submit" disabled={create.isPending || !goal.trim()}>
					New lesson
				</button>
				{state.anchor && (
					<button
						type="button"
						onClick={() => start(true)}
						disabled={create.isPending || !goal.trim()}
					>
						From pinned anchor
					</button>
				)}
			</form>
			{(error || create.error) && (
				<p role="alert">{(error ?? create.error)?.message}</p>
			)}
			{isPending && <p>Loading lessons…</p>}
			<div className="lesson-list">
				{data?.lessons.map((lesson) => (
					<Link
						key={lesson.id}
						to="/classroom/$lessonId"
						params={{ lessonId: lesson.id }}
						className="lesson-row"
					>
						<div>
							<h2>{lesson.title}</h2>
							<p>{lesson.goal}</p>
						</div>
						<span>{lesson.phase}</span>
						<time dateTime={lesson.updatedAt}>
							{new Date(lesson.updatedAt).toLocaleDateString()}
						</time>
					</Link>
				))}
			</div>
			{data?.lessons.length === 0 && (
				<p>No lessons yet. Choose a topic above.</p>
			)}
		</section>
	);
}
