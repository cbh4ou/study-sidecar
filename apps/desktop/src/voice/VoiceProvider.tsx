import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useSettings } from "../lib/api";
import { onDaemonMessage, useHudMessages } from "../lib/ws";
import { bindPushToTalk } from "./PushToTalk";
import { VoiceClient, type VoiceProfile, type VoiceState } from "./VoiceClient";

type VoiceControls = {
	voice: VoiceState;
	toggleListening: () => void;
	toggleMute: () => void;
	speak: (text: string, voice?: VoiceProfile) => void;
	startPtt: () => void;
	stopPtt: () => void;
	interrupt: () => void;
	setTranscriptTarget: (target: ((text: string) => void) | undefined) => void;
	configure: (engines: { stt?: string; tts?: string }) => void;
};
const VoiceContext = createContext<VoiceControls | undefined>(undefined);
const initial: VoiceState = {
	status: "offline",
	detail: "Voice worker offline, run bun run sidecar up --with-voice",
	listening: false,
	muted: false,
	vad: false,
	playback: false,
	transcript: "",
};
export function VoiceProvider({ children }: { children: ReactNode }) {
	const { send } = useHudMessages();
	const { data: settings } = useSettings();
	const [voice, setVoice] = useState(initial);
	const client = useRef<VoiceClient | undefined>(undefined);
	const held = useRef(false);
	const stoppedAt = useRef(0);
	const target = useRef<((text: string) => void) | undefined>(undefined);
	const setTranscriptTarget = useCallback(
		(next: ((text: string) => void) | undefined) => {
			target.current = next;
		},
		[],
	);
	const interrupt = useCallback(() => {
		client.current?.interrupt();
		send({ type: "interrupt" });
	}, [send]);
	const startPtt = useCallback(() => {
		if (held.current) return;
		held.current = true;
		client.current?.interrupt();
		send({ type: "ptt_start" });
		void client.current?.setListening(true);
	}, [send]);
	const stopPtt = useCallback(() => {
		if (!held.current) return;
		held.current = false;
		stoppedAt.current = performance.now();
		send({ type: "ptt_stop" });
		void client.current?.setListening(false);
	}, [send]);
	useEffect(() => {
		let turnId = "",
			startedAt = 0,
			measured = false;
		const next = new VoiceClient({
			onState: setVoice,
			onFirstAudio: () => {
				if (turnId && !measured) {
					measured = true;
					send({
						type: "turn_telemetry",
						turnId,
						tts_first_audio_ms: Math.max(0, performance.now() - startedAt),
					});
				}
			},
			onTranscript: (text) => {
				if (target.current) target.current(text);
				else
					send({
						type: "question",
						text,
						source: "ptt",
						sttMs: Math.max(0, performance.now() - stoppedAt.current),
					});
			},
		});
		client.current = next;
		void next.connect();
		const unsub = onDaemonMessage((message) => {
			if (message.type === "turn_started") {
				turnId = message.turnId;
				startedAt = performance.now();
				measured = false;
				next.interrupt();
			}
			if (
				message.type === "fast_answer" &&
				!("speak" in message && message.speak === false) &&
				!(
					"__TAURI_INTERNALS__" in window &&
					new URLSearchParams(location.search).get("window") === "main"
				)
			)
				next.speak(message.text);
			if (message.type === "steering_prompt" && message.prompt) {
				void import("@tauri-apps/api/core")
					.then(({ invoke }) => invoke("copy_text", { text: message.prompt }))
					.catch(() =>
						navigator.clipboard
							?.writeText(message.prompt ?? "")
							.catch(() => undefined),
					);
			}
		});
		return () => {
			unsub();
			void next.close();
			if (client.current === next) client.current = undefined;
		};
	}, [send]);
	useEffect(() => {
		if ("__TAURI_INTERNALS__" in window) {
			const escapeKey = (event: KeyboardEvent) => {
				if (event.key === "Escape") interrupt();
			};
			window.addEventListener("keydown", escapeKey);
			let gone = false;
			const stops: Array<() => void> = [];
			for (const [event, callback] of [
				["voice://ptt-start", startPtt],
				["voice://ptt-stop", stopPtt],
				["voice://interrupt", interrupt],
			] as const)
				void listen(event, callback).then((stop) => {
					if (gone) stop();
					else stops.push(stop);
				});
			return () => {
				gone = true;
				window.removeEventListener("keydown", escapeKey);
				for (const stop of stops) stop();
			};
		}
		return bindPushToTalk(
			window,
			startPtt,
			stopPtt,
			interrupt,
			settings?.hotkeys.ptt ?? "Alt+Space",
		);
	}, [startPtt, stopPtt, interrupt, settings?.hotkeys.ptt]);
	useEffect(() => {
		if (
			held.current ||
			voice.status !== "ready" ||
			("__TAURI_INTERNALS__" in window &&
				new URLSearchParams(location.search).get("window") === "main")
		)
			return;
		const listening = settings?.voice.mode === "vad";
		if (client.current && client.current.state.listening !== listening)
			void client.current.setListening(listening);
	}, [voice.status, settings?.voice.mode]);
	useEffect(() => {
		if (voice.status === "ready")
			client.current?.configure({
				stt: settings?.voice.stt,
				tts: settings?.voice.tts,
			});
	}, [voice.status, settings?.voice.stt, settings?.voice.tts]);
	const toggleListening = () => {
		const next = client.current;
		if (next) void next.setListening(!next.state.listening);
	};
	const toggleMute = () => {
		const next = client.current;
		if (!next) return;
		const muted = !next.state.muted;
		if (muted) void next.setListening(false);
		next.setMuted(muted);
	};
	const speak = useCallback(
		(text: string, profile?: VoiceProfile) =>
			client.current?.speak(text, profile),
		[],
	);
	const configure = useCallback(
		(engines: { stt?: string; tts?: string }) =>
			client.current?.configure(engines),
		[],
	);
	return (
		<VoiceContext.Provider
			value={{
				voice,
				toggleListening,
				toggleMute,
				speak,
				startPtt,
				stopPtt,
				interrupt,
				setTranscriptTarget,
				configure,
			}}
		>
			{children}
		</VoiceContext.Provider>
	);
}
export function useVoice() {
	const value = useContext(VoiceContext);
	if (!value) throw new Error("VoiceProvider is required");
	return value;
}
