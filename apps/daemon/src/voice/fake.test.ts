import { afterEach, describe, expect, test } from "bun:test";
import {
	createFakeVoiceBridge,
	FAKE_SILENT_CHUNK,
	FAKE_TRANSCRIPT,
} from "./fake.ts";
import {
	createVoiceBridge,
	localOutputEvents,
	selectVoiceEngine,
	type VoiceEvent,
	voiceEngines,
} from "./router.ts";

const waitFor = async (
	events: VoiceEvent[],
	predicate: (event: VoiceEvent) => boolean,
	timeoutMs = 2_000,
) => {
	const deadline = Date.now() + timeoutMs;
	while (!events.some(predicate)) {
		if (Date.now() > deadline) throw new Error("timed out waiting for event");
		await Bun.sleep(5);
	}
};

describe("fake voice engine", () => {
	const priorFake = process.env.SIDECAR_FAKE;
	afterEach(() => {
		if (priorFake === undefined) delete process.env.SIDECAR_FAKE;
		else process.env.SIDECAR_FAKE = priorFake;
	});

	test("selectVoiceEngine picks fake from env or explicit option", async () => {
		process.env.SIDECAR_FAKE = "1";
		expect(await selectVoiceEngine(undefined)).toEqual({ kind: "fake" });
		expect(await selectVoiceEngine("token")).toEqual({ kind: "fake" });
		delete process.env.SIDECAR_FAKE;
		expect(await selectVoiceEngine(undefined, { fake: true })).toEqual({
			kind: "fake",
		});
		process.env.SIDECAR_FAKE = "1";
		const priorKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			expect(await selectVoiceEngine(undefined, { fake: false })).toEqual({
				kind: "none",
			});
		} finally {
			if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
		}
	});

	test("listenStop emits the fixed final transcript after a short delay", async () => {
		const events: VoiceEvent[] = [];
		const bridge = await createVoiceBridge(
			{ kind: "fake" },
			{ onEvent: (event) => events.push(event) },
		);
		expect(bridge.available).toBe(true);
		const started = Date.now();
		bridge.listenStart();
		bridge.audio("AAE=");
		bridge.listenStop();
		expect(events).toEqual([]);
		await waitFor(events, (event) => event.type === "transcript");
		expect(Date.now() - started).toBeGreaterThanOrEqual(100);
		expect(events).toEqual([
			{ type: "transcript", final: true, text: FAKE_TRANSCRIPT },
		]);
		expect(FAKE_TRANSCRIPT).toBe("what is a channel ack");
		bridge.close();
	});

	test("speak emits started, three silent 100 ms chunks, then complete", async () => {
		const events: VoiceEvent[] = [];
		const bridge = createFakeVoiceBridge(
			{ onEvent: (event) => events.push(event) },
			{ chunkDelayMs: 1 },
		);
		bridge.speak("voice-1", "Hello there.");
		await waitFor(events, (event) => event.type === "tts_stopped");
		const chunk = {
			type: "tts_audio",
			id: "voice-1",
			pcm_b16: FAKE_SILENT_CHUNK,
		} satisfies VoiceEvent;
		expect(events).toEqual([
			{ type: "tts_started", id: "voice-1" },
			chunk,
			chunk,
			chunk,
			{ type: "tts_stopped", id: "voice-1", reason: "complete" },
		]);
		const pcm = Buffer.from(FAKE_SILENT_CHUNK, "base64");
		expect(pcm.length).toBe(3_200); // 1,600 s16le samples = 100 ms at 16 kHz
		expect(pcm.every((byte) => byte === 0)).toBe(true);
		bridge.close();
	});

	test("interrupt stops speech with reason interrupted and no further audio", async () => {
		const events: VoiceEvent[] = [];
		const bridge = createFakeVoiceBridge(
			{ onEvent: (event) => events.push(event) },
			{ chunkDelayMs: 20 },
		);
		bridge.speak("voice-1", "Hello there.");
		await waitFor(events, (event) => event.type === "tts_audio");
		bridge.interrupt();
		await Bun.sleep(80);
		expect(events).toEqual([
			{ type: "tts_started", id: "voice-1" },
			{ type: "tts_audio", id: "voice-1", pcm_b16: FAKE_SILENT_CHUNK },
			{ type: "tts_stopped", id: "voice-1", reason: "interrupted" },
		]);
		bridge.interrupt(); // idle interrupt is a no-op
		expect(events).toHaveLength(3);
		bridge.close();
	});

	test("a new speak supersedes the previous one", async () => {
		const events: VoiceEvent[] = [];
		const bridge = createFakeVoiceBridge(
			{ onEvent: (event) => events.push(event) },
			{ chunkDelayMs: 1 },
		);
		bridge.speak("voice-1", "First.");
		bridge.speak("voice-2", "Second.");
		await waitFor(
			events,
			(event) => event.type === "tts_stopped" && event.id === "voice-2",
		);
		expect(events.slice(0, 2)).toEqual([
			{ type: "tts_started", id: "voice-1" },
			{ type: "tts_stopped", id: "voice-1", reason: "superseded" },
		]);
		expect(
			events.filter(
				(event) => event.type === "tts_audio" && event.id === "voice-1",
			),
		).toEqual([]);
		bridge.close();
	});

	test("close cancels pending events", async () => {
		const events: VoiceEvent[] = [];
		const bridge = createFakeVoiceBridge(
			{ onEvent: (event) => events.push(event) },
			{ transcriptDelayMs: 10, chunkDelayMs: 10 },
		);
		bridge.listenStop();
		bridge.speak("voice-1", "Hello.");
		bridge.close();
		await Bun.sleep(50);
		expect(events).toEqual([{ type: "tts_started", id: "voice-1" }]);
	});
});

describe("voiceEngines", () => {
	test("reports engines per kind", () => {
		expect(voiceEngines({ kind: "fake" })).toEqual({
			stt: ["fake"],
			tts: ["fake"],
		});
		expect(voiceEngines({ kind: "realtime" })).toEqual({
			stt: ["openai-realtime"],
			tts: ["openai-realtime"],
		});
		expect(voiceEngines({ kind: "none" })).toEqual({ stt: [], tts: [] });
		expect(
			voiceEngines({ kind: "local", wsUrl: "ws://127.0.0.1:1/?token=unseen" }),
		).toEqual({ stt: [], tts: [] });
	});

	test("caches local worker engines from the readiness probe", async () => {
		const token = "engines-token";
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(
						JSON.stringify({
							type: "ready",
							vad: "energy",
							tts: "kokoro",
							engines: { stt: ["faster-whisper", 7], tts: ["kokoro"] },
						}),
					);
				},
				message() {},
			},
		});
		try {
			const engine = await selectVoiceEngine(token, {
				url: `ws://127.0.0.1:${server.port}`,
				fake: false,
			});
			expect(engine.kind).toBe("local");
			expect(voiceEngines(engine)).toEqual({
				stt: ["faster-whisper"],
				tts: ["kokoro"],
			});
		} finally {
			server.stop(true);
		}
	});

	test("forwards worker engines on the ready event", () => {
		expect(
			localOutputEvents({
				type: "ready",
				vad: "energy",
				tts: "kokoro",
				engines: { stt: ["faster-whisper"], tts: ["kokoro", "piper"] },
			}),
		).toEqual([
			{
				type: "ready",
				vad: "energy",
				tts: "kokoro",
				engines: { stt: ["faster-whisper"], tts: ["kokoro", "piper"] },
			},
		]);
		expect(localOutputEvents({ type: "ready", vad: "energy" })).toEqual([
			{ type: "ready", vad: "energy", tts: undefined },
		]);
	});
});
