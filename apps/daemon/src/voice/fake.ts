import type {
	VoiceBridge,
	VoiceEngines,
	VoiceEvent,
	VoiceHandlers,
} from "./router.ts";

export const FAKE_TRANSCRIPT = "what is a channel ack";
export const FAKE_ENGINES: VoiceEngines = { stt: ["fake"], tts: ["fake"] };

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 100;
const CHUNK_COUNT = 3;
// 100 ms of silent 16 kHz mono s16le PCM: 1,600 zero samples.
export const FAKE_SILENT_CHUNK = Buffer.alloc(
	(SAMPLE_RATE * CHUNK_MS * 2) / 1000,
).toString("base64");

export type FakeVoiceOptions = {
	/** Delay between `listenStop` and the final transcript. */
	transcriptDelayMs?: number;
	/** Delay between successive `tts_audio` chunks (and before the first). */
	chunkDelayMs?: number;
};

/**
 * Deterministic in-process voice engine for fake mode: no worker, no network,
 * no GPU. Mirrors the local worker's frame contract. The daemon's own `ready`
 * frame reports `FAKE_ENGINES` via `voiceEngines({ kind: "fake" })`.
 */
export function createFakeVoiceBridge(
	handlers: VoiceHandlers = {},
	options: FakeVoiceOptions = {},
): VoiceBridge {
	const transcriptDelay = options.transcriptDelayMs ?? 150;
	const chunkDelay = options.chunkDelayMs ?? CHUNK_MS;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let closed = false;
	let speaking: { id: string; timer?: ReturnType<typeof setTimeout> } | null =
		null;

	const emit = (event: VoiceEvent) => {
		if (!closed) handlers.onEvent?.(event);
	};
	const later = (ms: number, run: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			run();
		}, ms);
		timer.unref?.();
		timers.add(timer);
		return timer;
	};
	const stopSpeaking = (reason: string) => {
		if (!speaking) return;
		const { id, timer } = speaking;
		if (timer) {
			clearTimeout(timer);
			timers.delete(timer);
		}
		speaking = null;
		emit({ type: "tts_stopped", id, reason });
	};

	return {
		available: true,
		listenStart() {},
		listenStop() {
			later(transcriptDelay, () =>
				emit({ type: "transcript", final: true, text: FAKE_TRANSCRIPT }),
			);
		},
		audio() {},
		speak(id) {
			stopSpeaking("superseded");
			const current: { id: string; timer?: ReturnType<typeof setTimeout> } = {
				id,
			};
			speaking = current;
			emit({ type: "tts_started", id });
			let sent = 0;
			const next = () => {
				if (speaking !== current) return;
				emit({ type: "tts_audio", id, pcm_b16: FAKE_SILENT_CHUNK });
				sent += 1;
				if (sent < CHUNK_COUNT) current.timer = later(chunkDelay, next);
				else {
					speaking = null;
					emit({ type: "tts_stopped", id, reason: "complete" });
				}
			};
			current.timer = later(chunkDelay, next);
		},
		interrupt() {
			stopSpeaking("interrupted");
		},
		close() {
			closed = true;
			speaking = null;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
	};
}
