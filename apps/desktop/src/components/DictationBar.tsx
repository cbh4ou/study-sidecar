import { useId, useState } from "react";
import { useVoice } from "../voice/VoiceProvider";
export function DictationBar({
	onSubmit,
	placeholder = "Ask about one concept",
	disabled = false,
}: {
	onSubmit: (text: string) => void;
	placeholder?: string;
	disabled?: boolean;
}) {
	const id = useId();
	const [text, setText] = useState("");
	const { voice, startPtt, stopPtt } = useVoice();
	return (
		<form
			className="dictation-bar"
			onSubmit={(e) => {
				e.preventDefault();
				if (text.trim()) {
					onSubmit(text.trim());
					setText("");
				}
			}}
		>
			<label className="sr-only" htmlFor={id}>
				{placeholder}
			</label>
			<textarea
				id={id}
				rows={2}
				value={text}
				disabled={disabled}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
			/>
			<button
				type="button"
				aria-label="Hold to dictate"
				aria-pressed={voice.listening}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					startPtt();
				}}
				onPointerUp={stopPtt}
				onPointerCancel={stopPtt}
				onKeyDown={(e) => {
					if (e.key === " " && !e.repeat) {
						e.preventDefault();
						startPtt();
					}
				}}
				onKeyUp={(e) => {
					if (e.key === " ") {
						e.preventDefault();
						stopPtt();
					}
				}}
			>
				{voice.listening ? "Listening" : "Hold to talk"}
			</button>
			<button type="submit" disabled={disabled || !text.trim()}>
				Send
			</button>
		</form>
	);
}
