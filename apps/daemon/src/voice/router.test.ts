import { afterEach, describe, expect, test } from "bun:test";
import {
	createVoiceBridge,
	realtimeOutputEvents,
	realtimeRequest,
	selectVoiceEngine,
	VoiceBridgeError,
	type VoiceEvent,
} from "./router.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("voice router", () => {
	test("bridges the local worker protocol", async () => {
		const inputs: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(
						JSON.stringify({ type: "ready", vad: "energy", tts: "test" }),
					);
				},
				message(socket, data) {
					const input = JSON.parse(String(data)) as Record<string, unknown>;
					inputs.push(input);
					if (input.type === "audio")
						socket.send(JSON.stringify({ type: "vad", speech: true }));
					if (input.type === "speak") {
						socket.send(JSON.stringify({ type: "tts_started", id: input.id }));
						socket.send(
							JSON.stringify({
								type: "tts_audio",
								id: input.id,
								pcm_b16: "AQI=",
							}),
						);
						socket.send(
							JSON.stringify({
								type: "tts_stopped",
								id: input.id,
								reason: "complete",
							}),
						);
					}
					if (input.type === "interrupt")
						socket.send(
							JSON.stringify({
								type: "tts_stopped",
								id: "voice-1",
								reason: "interrupted",
							}),
						);
				},
			},
		});
		servers.push(server);
		const events: VoiceEvent[] = [];
		const complete = Promise.withResolvers<void>();
		const interrupted = Promise.withResolvers<void>();
		const bridge = await createVoiceBridge(
			{ kind: "local", wsUrl: `ws://127.0.0.1:${server.port}` },
			{
				onEvent: (event) => {
					events.push(event);
					if (event.type === "tts_stopped" && event.reason === "complete")
						complete.resolve();
					if (event.type === "tts_stopped" && event.reason === "interrupted")
						interrupted.resolve();
				},
			},
		);
		bridge.audio("AAE=");
		bridge.speak("voice-1", "Hello", { voice: "af_sky" });
		await complete.promise;
		bridge.interrupt();
		await interrupted.promise;
		expect(inputs).toContainEqual({ type: "audio", pcm_b16: "AAE=" });
		expect(inputs).toContainEqual({
			type: "speak",
			id: "voice-1",
			text: "Hello",
			voice: { voice: "af_sky" },
		});
		expect(events).toEqual(
			expect.arrayContaining([
				{ type: "vad", speech: true },
				{ type: "tts_started", id: "voice-1" },
				{ type: "tts_audio", id: "voice-1", pcm_b16: "AQI=" },
				{ type: "tts_stopped", id: "voice-1", reason: "complete" },
				{ type: "tts_stopped", id: "voice-1", reason: "interrupted" },
			]),
		);
		bridge.close();
	});

	test("selects only a ready local worker authenticated by its voice token", async () => {
		const token = "voice-secret";
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("unauthorized", { status: 403 });
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "ready", vad: "energy" }));
				},
			},
		});
		servers.push(server);

		expect(
			await selectVoiceEngine(token, {
				url: `ws://127.0.0.1:${server.port}`,
			}),
		).toEqual({
			kind: "local",
			wsUrl: `ws://127.0.0.1:${server.port}/?token=${token}`,
		});
	});

	test("rejects a tokenless or rogue listener without using port 8879", async () => {
		const prior = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const server = Bun.serve({
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "not-ready" }));
				},
			},
		});
		servers.push(server);
		try {
			expect(
				await selectVoiceEngine("voice-secret", {
					url: `ws://127.0.0.1:${server.port}`,
				}),
			).toEqual({ kind: "none" });
			expect(
				await selectVoiceEngine(undefined, {
					url: `ws://127.0.0.1:${server.port}`,
				}),
			).toEqual({ kind: "none" });
		} finally {
			if (prior === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prior;
		}
	});

	test("configures Realtime input transcription after opening", async () => {
		const previousKey = process.env.OPENAI_API_KEY;
		const PreviousWebSocket = globalThis.WebSocket;
		const sent: object[] = [];
		const errors: VoiceBridgeError[] = [];
		let socket: FakeWebSocket | undefined;
		class FakeWebSocket {
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onopen: (() => void) | null = null;

			constructor(_url: string, _options?: unknown) {
				socket = this;
				queueMicrotask(() => this.onopen?.());
			}

			send(message: string) {
				sent.push(JSON.parse(message));
			}

			close() {}
		}
		process.env.OPENAI_API_KEY = "test-key";
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		try {
			const bridge = await createVoiceBridge(
				{ kind: "realtime" },
				{ onError: (error) => errors.push(error) },
			);
			expect(sent[0]).toEqual({
				type: "session.update",
				session: {
					input_audio_transcription: { model: "whisper-1" },
					turn_detection: {
						type: "server_vad",
						create_response: false,
						interrupt_response: true,
					},
				},
			});
			socket?.onmessage?.({
				data: JSON.stringify({
					type: "conversation.item.input_audio_transcription.failed",
					error: { message: "transcription failed" },
				}),
			});
			expect(errors).toEqual([
				expect.objectContaining({ message: "transcription failed" }),
			]);
			expect(errors[0]).toBeInstanceOf(VoiceBridgeError);
			bridge.close();
		} finally {
			globalThis.WebSocket = PreviousWebSocket;
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
		}
	});

	test("maps Realtime request and event grammar without a network", () => {
		expect(realtimeRequest({ type: "audio", pcm_b16: "AAE=" })).toEqual({
			type: "input_audio_buffer.append",
			audio: "AAE=",
		});
		expect(
			realtimeRequest({ type: "speak", id: "voice-1", text: "Hello" }),
		).toEqual({
			type: "response.create",
			response: { modalities: ["audio"], instructions: "Hello" },
		});
		expect(
			realtimeOutputEvents(
				{ type: "response.audio.delta", delta: "AQI=" },
				"voice-1",
			),
		).toEqual([{ type: "tts_audio", id: "voice-1", pcm_b16: "AQI=" }]);
		expect(
			realtimeOutputEvents(
				{ type: "response.done", response: { status: "cancelled" } },
				"voice-1",
			),
		).toEqual([{ type: "tts_stopped", id: "voice-1", reason: "interrupted" }]);
	});
});
