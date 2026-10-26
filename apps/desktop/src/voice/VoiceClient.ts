import { getSidecarToken } from "../lib/token";
import { MicrophoneCapture, PcmPlayback } from "./audio";

export type VoiceProfile = {
	language?: string;
	speed?: number;
	voice?: string;
};
export type VoiceState = {
	status: "offline" | "connecting" | "ready";
	detail: string;
	listening: boolean;
	muted: boolean;
	vad: boolean;
	playback: boolean;
	transcript: string;
	engines?: { stt: string[]; tts: string[] };
};

type WorkerMessage =
	| {
			type: "ready";
			vad: string;
			tts: string;
			engines?: { stt: string[]; tts: string[] };
	  }
	| { type: "vad"; speech: boolean }
	| { type: "transcript"; final: boolean; text: string }
	| { type: "tts_started"; id: string }
	| { type: "tts_audio"; id: string; pcm_b16: string }
	| { type: "tts_stopped"; id: string; reason: string }
	| { type: "error"; message: string };
type VoiceCapture = Pick<MicrophoneCapture, "start" | "stop">;
type VoicePlayback = Pick<PcmPlayback, "active" | "enqueue" | "stop">;

export type VoiceClientOptions = {
	onState: (state: VoiceState) => void;
	onTranscript: (text: string) => void;
	onFirstAudio?: () => void;
	daemonUrl?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	getToken?: () => Promise<string>;
	capture?: VoiceCapture;
	playback?: VoicePlayback;
	createPlayback?: (onActiveChange: (active: boolean) => void) => VoicePlayback;
};
const offlineMessage =
	"Voice worker offline, run bun run sidecar up --with-voice";

export class VoiceClient {
	#socket?: WebSocket;
	#epoch = 0;
	#speech: Array<{ text: string; voice?: VoiceProfile }> = [];
	#speaking = false;
	#firstAudio = false;
	#capture: VoiceCapture;
	#playback: VoicePlayback;
	#wantListening = false;
	#dropAudio = false;
	#state: VoiceState = {
		status: "offline",
		detail: offlineMessage,
		listening: false,
		muted: false,
		vad: false,
		playback: false,
		transcript: "",
	};

	constructor(private readonly options: VoiceClientOptions) {
		this.#capture = options.capture ?? new MicrophoneCapture();
		this.#playback =
			options.playback ??
			options.createPlayback?.((playback) => this.#set({ playback })) ??
			new PcmPlayback((playback) => this.#set({ playback }));
	}

	get state(): VoiceState {
		return this.#state;
	}

	async connect(): Promise<void> {
		const epoch = ++this.#epoch;
		this.#socket?.close();
		this.#set({ status: "connecting", detail: "Connecting to voice worker…" });
		try {
			const token = await (this.options.getToken ?? getSidecarToken)();
			const response = await (this.options.fetch ?? fetch)(
				`${this.options.daemonUrl ?? "http://127.0.0.1:4321"}/voice`,
				{ headers: token ? { Authorization: `Bearer ${token}` } : {} },
			);
			const voice = (await response.json()) as { ws_url?: string | null };
			if (epoch !== this.#epoch) return;
			if (!response.ok || !voice.ws_url)
				return this.#set({ status: "offline", detail: offlineMessage });
			// The daemon is the only endpoint the desktop bearer may reach; a
			// ws_url anywhere else is refused regardless of port.
			const base = new URL(this.options.daemonUrl ?? "http://127.0.0.1:4321");
			const url = new URL(voice.ws_url);
			if (url.host !== base.host)
				return this.#set({ status: "offline", detail: offlineMessage });
			if (token) url.searchParams.set("token", token);
			const socket = new WebSocket(url.toString());
			this.#socket = socket;
			socket.onopen = () =>
				this.#set({
					status: "connecting",
					detail: "Connecting to voice worker…",
				});
			socket.onmessage = ({ data }) => {
				if (this.#socket !== socket) return;
				try {
					this.#onMessage(JSON.parse(String(data)) as WorkerMessage);
				} catch {
					/* Ignore malformed worker frames. */
				}
			};
			socket.onerror = () =>
				this.#set({ status: "offline", detail: offlineMessage });
			socket.onclose = () => {
				if (this.#socket === socket)
					this.#set({ status: "offline", detail: offlineMessage });
			};
		} catch {
			this.#set({ status: "offline", detail: offlineMessage });
		}
	}

	async setListening(listening: boolean): Promise<void> {
		this.#wantListening = listening;
		if (!listening) {
			this.#send({ type: "listen_stop" });
			await this.#capture.stop();
			this.#set({ listening: false, vad: false });
			return;
		}
		if (this.#state.status !== "ready") {
			void this.connect();
			return;
		}
		try {
			if (!this.#state.engines?.stt.includes("fake"))
				await this.#capture.start((pcm_b16) => {
					if (!this.#state.muted) this.#send({ type: "audio", pcm_b16 });
				});
			if (!this.#wantListening) {
				await this.#capture.stop();
				return;
			}
			this.#send({ type: "listen_start" });
			this.#set({ listening: true });
		} catch {
			this.#wantListening = false;
			this.#set({
				listening: false,
				detail: "Microphone permission is required for voice.",
			});
		}
	}

	setMuted(muted: boolean): void {
		if (muted) this.interrupt();
		this.#set({ muted });
	}

	configure(engines: { stt?: string; tts?: string }): void {
		this.#send({ type: "configure", ...engines });
	}
	speak(text: string, voice?: VoiceProfile): void {
		if (text.trim() && !this.#state.muted) {
			this.#speech.push({ text, voice });
			this.#nextSpeech();
		}
	}
	#nextSpeech(): void {
		if (this.#speaking) return;
		const next = this.#speech.shift();
		if (!next) return;
		this.#speaking = true;
		this.#send({ type: "speak", id: crypto.randomUUID(), ...next });
	}

	interrupt(): void {
		this.#dropAudio = true;
		this.#speech = [];
		this.#speaking = false;
		this.#send({ type: "interrupt" });
		this.#playback.stop();
	}

	async close(): Promise<void> {
		this.#epoch++;
		this.#wantListening = false;
		this.interrupt();
		this.#socket?.close();
		this.#socket = undefined;
		await this.#capture.stop();
	}

	#onMessage(message: WorkerMessage): void {
		if (message.type === "ready") {
			this.#set({
				status: "ready",
				engines: message.engines,
				detail: `Voice ready (${message.vad} VAD, ${message.tts} TTS)`,
			});
			if (this.#wantListening) void this.setListening(true);
			return;
		}
		if (message.type === "vad") {
			this.#set({ vad: message.speech });
			if (message.speech && this.#playback.active) this.interrupt();
			return;
		}
		if (message.type === "transcript") {
			this.#set({ transcript: message.text });
			if (message.final && message.text.trim())
				this.options.onTranscript(message.text);
			return;
		}
		if (message.type === "tts_started") {
			this.#dropAudio = false;
			this.#firstAudio = false;
			return;
		}
		if (message.type === "tts_audio") {
			if (!this.#dropAudio) {
				if (!this.#firstAudio) {
					this.#firstAudio = true;
					this.options.onFirstAudio?.();
				}
				void this.#playback.enqueue(message.pcm_b16);
			}
			return;
		}
		if (message.type === "tts_stopped") {
			this.#speaking = false;
			this.#nextSpeech();
			return;
		}
		if (message.type === "error") this.#set({ detail: message.message });
	}

	#send(message: object): void {
		if (this.#socket?.readyState === WebSocket.OPEN)
			this.#socket.send(JSON.stringify(message));
	}

	#set(change: Partial<VoiceState>): void {
		this.#state = { ...this.#state, ...change };
		this.options.onState(this.#state);
	}
}
