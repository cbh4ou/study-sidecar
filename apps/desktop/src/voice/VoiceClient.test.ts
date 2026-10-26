import { afterEach, expect, test } from "bun:test";
import { VoiceClient, type VoiceState } from "./VoiceClient";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

test("forwards voice frames through the daemon-provided websocket", async () => {
	const received: Array<Record<string, unknown>> = [];
	const complete = Promise.withResolvers<void>();
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
				const message = JSON.parse(String(data)) as Record<string, unknown>;
				received.push(message);
				if (message.type === "speak") {
					socket.send(JSON.stringify({ type: "tts_started", id: message.id }));
					socket.send(
						JSON.stringify({
							type: "tts_audio",
							id: message.id,
							pcm_b16: "AAE=",
						}),
					);
					socket.send(
						JSON.stringify({
							type: "tts_stopped",
							id: message.id,
							reason: "complete",
						}),
					);
					complete.resolve();
				}
			},
		},
	});
	servers.push(server);

	let frame: ((pcm_b16: string) => void) | undefined;
	let active = false;
	const ready = Promise.withResolvers<void>();
	const playbackStopped = Promise.withResolvers<void>();
	const states: VoiceState[] = [];
	const client = new VoiceClient({
		daemonUrl: `http://127.0.0.1:${server.port}`,
		onState: (state) => {
			states.push(state);
			if (state.status === "ready") ready.resolve();
		},
		onTranscript() {},
		getToken: async () => "daemon-token",
		fetch: async () =>
			Response.json({ ws_url: `ws://127.0.0.1:${server.port}/voice-ws` }),
		capture: {
			async start(onFrame) {
				frame = onFrame;
			},
			async stop() {},
		},
		createPlayback(onActiveChange) {
			return {
				get active() {
					return active;
				},
				async enqueue() {
					active = true;
					onActiveChange(true);
					active = false;
					onActiveChange(false);
					playbackStopped.resolve();
				},
				stop() {
					active = false;
					onActiveChange(false);
				},
			};
		},
	});

	await client.connect();
	await ready.promise;
	await client.setListening(true);
	frame?.("AAE=");
	client.speak("hello", { language: "en", speed: 1.2, voice: "af_sky" });
	await complete.promise;
	await playbackStopped.promise;

	expect(received).toEqual(
		expect.arrayContaining([
			{ type: "listen_start" },
			{ type: "audio", pcm_b16: "AAE=" },
			expect.objectContaining({
				type: "speak",
				text: "hello",
				voice: { language: "en", speed: 1.2, voice: "af_sky" },
			}),
		]),
	);
	expect(states.some((state) => state.status === "ready")).toBe(true);
	expect(states.some((state) => state.playback)).toBe(true);
	expect(client.state.playback).toBe(false);
	await client.close();
});

test("never sends the daemon token to the local worker port", async () => {
	const states: VoiceState[] = [];
	const client = new VoiceClient({
		onState: (state) => states.push(state),
		onTranscript() {},
		getToken: async () => "daemon-token",
		fetch: async () => Response.json({ ws_url: "ws://127.0.0.1:8879" }),
	});

	await client.connect();

	expect(client.state.status).toBe("offline");
	expect(states.at(-1)?.detail).toContain("Voice worker offline");
});

test("closed voice client ignores stale discovery without opening a socket", async () => {
	const discovery = Promise.withResolvers<Response>();
	const client = new VoiceClient({
		onState() {},
		onTranscript() {},
		getToken: async () => "token",
		fetch: () => discovery.promise,
		capture: {
			async start() {
				throw new Error("capture must stay closed");
			},
			async stop() {},
		},
		playback: { active: false, async enqueue() {}, stop() {} },
	});
	const opening = client.connect();
	await Bun.sleep(0);
	await client.close();
	discovery.resolve(Response.json({ ws_url: "ws://127.0.0.1:4321/voice-ws" }));
	await opening;
	expect(client.state.status).toBe("offline");
	expect(client.state.listening).toBe(false);
});

test("fake PTT bypasses microphone and speech sentences wait for prior completion", async () => {
	const frames: Array<Record<string, unknown>> = [];
	const ready = Promise.withResolvers<void>();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	let finishFirst = () => {};
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("upgrade", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(
					JSON.stringify({
						type: "ready",
						vad: "fake",
						tts: "fake",
						engines: { stt: ["fake"], tts: ["fake"] },
					}),
				);
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw));
				frames.push(frame);
				if (frame.type === "speak") {
					socket.send(JSON.stringify({ type: "tts_started", id: frame.id }));
					if (frame.text === "First sentence.") {
						finishFirst = () =>
							socket.send(
								JSON.stringify({
									type: "tts_stopped",
									id: frame.id,
									reason: "complete",
								}),
							);
						first.resolve();
					} else second.resolve();
				}
			},
		},
	});
	servers.push(server);
	let captures = 0;
	const client = new VoiceClient({
		daemonUrl: `http://127.0.0.1:${server.port}`,
		getToken: async () => "token",
		fetch: async () =>
			Response.json({ ws_url: `ws://127.0.0.1:${server.port}/voice-ws` }),
		onState(s) {
			if (s.status === "ready") ready.resolve();
		},
		onTranscript() {},
		capture: {
			async start() {
				captures++;
			},
			async stop() {},
		},
		playback: { active: false, async enqueue() {}, stop() {} },
	});
	await client.connect();
	await ready.promise;
	await client.setListening(true);
	await client.setListening(false);
	client.speak("First sentence.");
	client.speak("Second sentence.");
	await first.promise;
	expect(captures).toBe(0);
	expect(frames.filter((f) => f.type === "speak")).toHaveLength(1);
	finishFirst();
	await second.promise;
	expect(frames.filter((f) => f.type === "speak").map((f) => f.text)).toEqual([
		"First sentence.",
		"Second sentence.",
	]);
	await client.close();
});
