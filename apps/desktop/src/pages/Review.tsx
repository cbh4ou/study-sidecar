import { useCallback, useEffect, useState } from "react";
import { DictationBar } from "../components/DictationBar";
import { useDueCards } from "../lib/api";
import type { Card } from "../lib/protocol";
import { daemonRequest, useHudMessages } from "../lib/ws";
import { useVoice } from "../voice/VoiceProvider";
import { sourceLabel } from "./Classroom";
export function ReviewCard({
	card,
	onGrade,
}: {
	card: Card;
	onGrade?: (rating: string) => void;
}) {
	const { send } = useHudMessages();
	const { setTranscriptTarget } = useVoice();
	const [graded, setGraded] = useState(false);
	const [error, setError] = useState("");
	const voiceGrade = useCallback(
		(text: string) => {
			void daemonRequest<{ rating: string }>(
				`/api/cards/${encodeURIComponent(card.id)}/answer`,
				{ method: "POST", body: { text } },
			)
				.then((r) => {
					setGraded(true);
					onGrade?.(r.rating);
				})
				.catch((e) => setError(e.message));
		},
		[card.id, onGrade],
	);
	useEffect(() => {
		setTranscriptTarget(voiceGrade);
		return () => setTranscriptTarget(undefined);
	}, [setTranscriptTarget, voiceGrade]);
	return (
		<article className="review-card">
			<h2>{card.question}</h2>
			{card.example && (
				<details>
					<summary>Show your example</summary>
					<pre>{card.example}</pre>
				</details>
			)}
			<p>Source: {sourceLabel(card.source)}</p>
			<p>Recall your answer, then choose how it felt.</p>
			<DictationBar
				onSubmit={voiceGrade}
				placeholder="Recall aloud or say a grade"
				disabled={graded}
			/>
			<div className="grade-buttons">
				{(["again", "hard", "good", "easy"] as const).map((r) => (
					<button
						type="button"
						key={r}
						disabled={graded}
						onClick={() => {
							send({ type: "grade", cardId: card.id, rating: r });
							setGraded(true);
							onGrade?.(r);
						}}
					>
						{r[0]?.toUpperCase()}
						{r.slice(1)}
					</button>
				))}
			</div>
			{error && <p role="alert">{error}</p>}
		</article>
	);
}
export function Review() {
	const { data, isPending, error } = useDueCards();
	const [completed, setCompleted] = useState<string[]>([]);
	const cards = data?.cards.filter((c) => !completed.includes(c.id)) ?? [];
	return (
		<section>
			<header className="page-heading">
				<div>
					<h1>Review</h1>
					<p>A short recall check when you are ready.</p>
				</div>
				<span>{cards.length} due</span>
			</header>
			{isPending && <p>Loading cards…</p>}
			{error && <p role="alert">{error.message}</p>}
			{!isPending && !error && !cards.length && (
				<div className="empty-state">
					<h2>You are up to date</h2>
					<p>New cards appear here as concepts come due.</p>
				</div>
			)}
			{cards[0] && (
				<ReviewCard
					key={cards[0].id}
					card={cards[0]}
					onGrade={() => setCompleted([...completed, cards[0]?.id ?? ""])}
				/>
			)}
		</section>
	);
}
