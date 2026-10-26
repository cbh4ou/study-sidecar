import { useEffect, useState } from "react";
import { useDueCards } from "../lib/api";
import type { Card } from "../lib/protocol";
import { useHudMessages } from "../lib/ws";
import { ReviewCard } from "../pages/Review";
import { Sessions } from "../pages/Sessions";
import { useVoice } from "../voice/VoiceProvider";
export function PillStates({
	onExpand,
	onOpen,
	onPicker,
	onCardChange,
}: {
	onExpand: () => void;
	onOpen: () => void;
	onPicker?: (open: boolean) => void;
	onCardChange?: (active: boolean) => void;
}) {
	const { state, send } = useHudMessages();
	const { voice, startPtt, stopPtt, interrupt } = useVoice();
	const [picker, setPicker] = useState(false);
	const { data: due } = useDueCards();
	const [requestedCard, setRequestedCard] = useState<Card>();
	const [dismissed, setDismissed] = useState("");
	const [anchorDismissed, setAnchorDismissed] = useState("");
	const anchor =
		state.anchor && JSON.stringify(state.anchor.source) !== anchorDismissed
			? state.anchor
			: undefined;
	const candidate = requestedCard ?? state.card;
	const card = candidate?.id !== dismissed ? candidate : undefined;
	useEffect(() => {
		onCardChange?.(Boolean(card));
		return () => onCardChange?.(false);
	}, [card, onCardChange]);
	const status = voice.listening
		? "listening"
		: voice.playback
			? "speaking"
			: (state.pillStatus ?? "idle");
	return (
		<div className={`pill-surface pill-${status}`}>
			<div className="pill-topline">
				<button
					type="button"
					className="session-chip"
					aria-expanded={picker}
					onClick={() => {
						setPicker(!picker);
						onPicker?.(!picker);
					}}
				>
					{state.session?.project ?? "Study Sidecar"}
					<small>
						{state.boundSession?.follow === false ? "Pinned" : "Follow active"}
					</small>
				</button>
				<button
					type="button"
					aria-label="Hold to talk"
					aria-pressed={voice.listening}
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture(e.pointerId);
						startPtt();
					}}
					onPointerUp={stopPtt}
					onPointerCancel={stopPtt}
				>
					{voice.listening ? "●" : "Mic"}
				</button>
				<button
					type="button"
					aria-label="Review due cards"
					disabled={!due?.cards.length}
					onClick={() => setRequestedCard(due?.cards[0])}
				>
					{state.dueCount ?? 0} due
				</button>
				<button type="button" aria-label="Expand pill" onClick={onExpand}>
					+
				</button>
			</div>
			{status === "listening" && (
				<div className="pill-line" aria-live="polite">
					<span
						className="level-meter"
						role="img"
						aria-label={voice.vad ? "Speech detected" : "Listening"}
					>
						{voice.vad ? "▂▅█▆▃" : "▁▂▁▂▁"}
					</span>
					{voice.transcript || state.transcript || "Listening…"}
				</div>
			)}
			{status === "thinking" && (
				<p className="pill-line thinking" role="status">
					Thinking
				</p>
			)}
			{state.fastAnswer && !voice.listening && !card && !anchor && (
				<div className="pill-answer">
					<p>{state.fastAnswer}</p>
					{state.deepReady && (
						<button type="button" onClick={onExpand}>
							More
						</button>
					)}
					<button type="button" onClick={interrupt}>
						Interrupt
					</button>
				</div>
			)}
			{anchor && (
				<section className="anchor-confirm">
					<h2>Pin this anchor?</h2>
					<pre>{anchor.preview}</pre>
					{[true, false].map((accept) => (
						<button
							key={String(accept)}
							type="button"
							onClick={() => {
								send({ type: "anchor_confirm", accept });
								setAnchorDismissed(JSON.stringify(anchor.source));
							}}
						>
							{accept ? "Pin anchor" : "Dismiss"}
						</button>
					))}
				</section>
			)}
			{card && (
				<ReviewCard
					key={card.id}
					card={card}
					compact
					onGrade={() => {
						setDismissed(card.id);
						setRequestedCard(undefined);
					}}
				/>
			)}
			{picker && (
				<div className="pill-picker">
					<Sessions
						picker
						onPick={() => {
							setPicker(false);
							onPicker?.(false);
						}}
					/>
				</div>
			)}
			<footer className="pill-footer">
				<button type="button" onClick={onOpen}>
					Open in app
				</button>
				<button type="button" onClick={() => send({ type: "anchor_pin" })}>
					Pin anchor
				</button>
			</footer>
		</div>
	);
}
