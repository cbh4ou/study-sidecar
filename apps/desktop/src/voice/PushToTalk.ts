export function shortcutMatches(
	event: KeyboardEvent,
	shortcut: string,
): boolean {
	const parts = shortcut.toLowerCase().split("+");
	const key = parts.at(-1);
	return (
		event.altKey === parts.includes("alt") &&
		event.ctrlKey === parts.includes("ctrl") &&
		event.metaKey === parts.includes("meta") &&
		event.shiftKey === parts.includes("shift") &&
		(key === "space" ? event.code === "Space" : event.key.toLowerCase() === key)
	);
}
export function bindPushToTalk(
	target: Window,
	start: () => void,
	stop: () => void,
	interrupt: () => void,
	shortcut = "Alt+Space",
): () => void {
	let held = false;
	const down = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			interrupt();
			return;
		}
		if (shortcutMatches(event, shortcut)) {
			event.preventDefault();
			if (!held) {
				held = true;
				start();
			}
		}
	};
	const up = (event: KeyboardEvent) => {
		const key = shortcut.split("+").at(-1)?.toLowerCase();
		if (
			held &&
			(key === "space"
				? event.code === "Space"
				: event.key.toLowerCase() === key)
		) {
			event.preventDefault();
			held = false;
			stop();
		}
	};
	const blur = () => {
		if (held) {
			held = false;
			stop();
		}
	};
	target.addEventListener("keydown", down);
	target.addEventListener("keyup", up);
	target.addEventListener("blur", blur);
	return () => {
		target.removeEventListener("keydown", down);
		target.removeEventListener("keyup", up);
		target.removeEventListener("blur", blur);
		blur();
	};
}
