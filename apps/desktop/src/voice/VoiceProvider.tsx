import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useHudMessages } from "../lib/ws";
import type { VoiceState } from "./VoiceClient";
import { VoiceClient } from "./VoiceClient";

const initialVoice: VoiceState = {
	status: "offline",
	detail: "Voice worker offline — run `bun run sidecar up --with-voice`",
	listening: false,
	muted: false,
	vad: false,
	playback: false,
	transcript: "",
};
type VoiceProfile = {
	language?: string;
	speed?: number;
	voice?: string;
};
type VoiceControls = {
	voice: VoiceState;
	toggleListening: () => void;
	toggleMute: () => void;
	speak: (text: string, voice?: VoiceProfile) => void;
};
const VoiceContext = createContext<VoiceControls | undefined>(undefined);

export function VoiceProvider({ children }: { children: ReactNode }) {
	const { send } = useHudMessages();
	const [voice, setVoice] = useState(initialVoice);
	const client = useRef<VoiceClient | undefined>(undefined);
	useEffect(() => {
		const next = new VoiceClient({
			onState: setVoice,
			onTranscript: (text) => send({ type: "question", text }),
		});
		client.current = next;
		void next.connect();
		let unlisten: (() => void) | undefined;
		let unlistenPtt: (() => void) | undefined;
		if ("__TAURI__" in window) {
			void listen("voice://mute-toggle", () => {
				const muted = !next.state.muted;
				if (muted) void next.setListening(false);
				next.setMuted(muted);
			}).then((stop) => {
				unlisten = stop;
			});
			void listen("voice://ptt-toggle", () => {
				void next.setListening(!next.state.listening);
			}).then((stop) => {
				unlistenPtt = stop;
			});
		}
		return () => {
			unlisten?.();
			unlistenPtt?.();
			void next.close();
			if (client.current === next) client.current = undefined;
		};
	}, [send]);
	function toggleListening(): void {
		const next = client.current;
		if (next) void next.setListening(!next.state.listening);
	}
	function toggleMute(): void {
		const next = client.current;
		if (!next) return;
		const muted = !next.state.muted;
		if (muted) void next.setListening(false);
		next.setMuted(muted);
	}
	function speak(text: string, voice?: VoiceProfile): void {
		client.current?.speak(text, voice);
	}
	return (
		<VoiceContext.Provider
			value={{ voice, toggleListening, toggleMute, speak }}
		>
			{children}
		</VoiceContext.Provider>
	);
}

export function useVoice(): VoiceControls {
	const value = useContext(VoiceContext);
	if (!value) throw new Error("VoiceProvider is required");
	return value;
}
