import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { MentorHud } from "../components/MentorHud";
import { PillStates } from "../components/PillStates";
import { useLiveInvalidation, useSettings } from "../lib/api";
import { useHudMessages } from "../lib/ws";
import { shortcutMatches } from "../voice/PushToTalk";
export function PillApp() {
	useLiveInvalidation();
	const { state, send } = useHudMessages();
	const { data: settings } = useSettings();
	const [expanded, setExpanded] = useState(false);
	const [picker, setPicker] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [dnd, setDnd] = useState(false);
	const native = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
	const open = useCallback(() => {
		const path = state.lessonId ? `/classroom/${state.lessonId}` : "/classroom";
		if (native) void invoke("open_main", { path }).catch(() => undefined);
		else window.open(path, "study-sidecar-main");
	}, [native, state.lessonId]);
	useEffect(() => {
		if (native)
			void invoke("set_hud_variant", {
				variant:
					expanded || picker
						? "expanded"
						: state.fastAnswer || state.anchor || reviewing
							? "card"
							: "compact",
			}).catch(() => undefined);
	}, [native, expanded, picker, state.fastAnswer, state.anchor, reviewing]);
	useEffect(() => {
		if (native) void invoke("set_dnd", { on: dnd }).catch(() => undefined);
	}, [native, dnd]);
	useEffect(() => {
		if (!native) return;
		let disposed = false;
		const stops: Array<() => void> = [];
		for (const [name, callback] of [
			["hud://expand", () => setExpanded((v) => !v)],
			["hud://open", open],
			[
				"hud://dnd",
				() =>
					setDnd((v) => {
						send({ type: "dnd", on: !v });
						return !v;
					}),
			],
			["hud://pin", () => send({ type: "anchor_pin" })],
		] as const)
			void listen(name, callback).then((stop) => {
				if (disposed) stop();
				else stops.push(stop);
			});
		return () => {
			disposed = true;
			for (const stop of stops) stop();
		};
	}, [native, send, open]);
	useEffect(() => {
		if (native) return;
		const handler = (event: KeyboardEvent) => {
			const hotkeys = settings?.hotkeys ?? {
				expand: "Alt+S",
				open: "Alt+O",
				dnd: "Alt+D",
				pin: "Alt+P",
				copy: "Alt+C",
			};
			if (shortcutMatches(event, hotkeys.expand ?? "Alt+S")) {
				event.preventDefault();
				setExpanded((v) => !v);
			} else if (shortcutMatches(event, hotkeys.open ?? "Alt+O")) {
				event.preventDefault();
				window.open(
					state.lessonId ? `/classroom/${state.lessonId}` : "/classroom",
					"study-sidecar-main",
				);
			} else if (shortcutMatches(event, hotkeys.dnd ?? "Alt+D")) {
				event.preventDefault();
				setDnd((v) => {
					send({ type: "dnd", on: !v });
					return !v;
				});
			} else if (shortcutMatches(event, hotkeys.pin ?? "Alt+P")) {
				event.preventDefault();
				send({ type: "anchor_pin" });
			} else if (shortcutMatches(event, hotkeys.copy ?? "Alt+C")) {
				event.preventDefault();
				void navigator.clipboard?.writeText(state.prompts.at(-1) ?? "");
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [native, settings?.hotkeys, state.lessonId, state.prompts, send]);
	return (
		<main
			aria-label="Study pill"
			className={`pill-app ${dnd ? "dnd-hidden" : ""}`}
		>
			{expanded ? (
				<>
					<button type="button" onClick={() => setExpanded(false)}>
						Collapse
					</button>
					<button type="button" onClick={open}>
						Open in app
					</button>
					<MentorHud embedded />
				</>
			) : (
				<PillStates
					onExpand={() => setExpanded(true)}
					onOpen={open}
					onPicker={setPicker}
					onCardChange={setReviewing}
				/>
			)}
		</main>
	);
}
