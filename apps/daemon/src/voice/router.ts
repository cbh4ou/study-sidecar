import { createFakeVoiceBridge, FAKE_ENGINES } from "./fake.ts";

const LOCAL_PORT = 8879;
const CONNECT_TIMEOUT_MS = 500;
const PROBE_CACHE_MS = 5_000;

export type VoiceProfile = {
	language?: string;
	speed?: number;
	voice?: string;
};
export type VoiceEngine =
	| { kind: "local"; wsUrl: string }
	| { kind: "realtime" }
	| { kind: "fake" }
	| { kind: "none" };
export type VoiceEngines = { stt: string[]; tts: string[] };
export type VoiceInput =
	| { type: "listen_start" | "listen_stop" | "interrupt" }
	| { type: "configure"; stt?: string; tts?: string }
	| { type: "audio"; pcm_b16: string }
	| { type: "speak"; id: string; text: string; voice?: VoiceProfile };
export type VoiceEvent =
	| { type: "ready"; vad?: string; tts?: string; engines?: VoiceEngines }
	| { type: "vad"; speech: boolean }
	| { type: "transcript"; final: boolean; text: string }
	| { type: "tts_started"; id: string }
	| { type: "tts_audio"; id: string; pcm_b16: string }
	| { type: "tts_stopped"; id: string; reason?: string };
export type VoiceHandlers = {
	onEvent?: (event: VoiceEvent) => void;
	onError?: (error: VoiceBridgeError) => void;
};
export type VoiceBridge = {
	available: boolean;
	configure?(engines: { stt?: string; tts?: string }): void;
	listenStart(): void;
	listenStop(): void;
	audio(pcm_b16: string): void;
	speak(id: string, text: string, voice?: VoiceProfile): void;
	interrupt(): void;
	close(): void;
};
export type SelectVoiceEngineOptions = {
	port?: number;
	url?: string;
	cacheMs?: number;
	/** Force the in-process fake engine. Defaults to `SIDECAR_FAKE === "1"`. */
	fake?: boolean;
	allowRealtime?: boolean;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const string = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

export class VoiceBridgeError extends Error {}
export class VoiceUnavailableError extends VoiceBridgeError {}

type Probe = { ready: boolean; engines?: VoiceEngines };

const probes = new Map<string, Probe & { expires: number }>();
// Engines last reported by each ready local worker, keyed by its wsUrl.
const localEngines = new Map<string, VoiceEngines>();

const stringList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

export function parseEngines(value: unknown): VoiceEngines | undefined {
	const record = object(value);
	if (!record) return undefined;
	return { stt: stringList(record.stt), tts: stringList(record.tts) };
}

async function localReady(url: string): Promise<Probe> {
	try {
		const socket = new WebSocket(url);
		return await new Promise<Probe>((resolve) => {
			let settled = false;
			const finish = (probe: Probe) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.close();
				resolve(probe);
			};
			const notReady = { ready: false };
			const timeout = setTimeout(() => finish(notReady), CONNECT_TIMEOUT_MS);
			timeout.unref();
			socket.onerror = () => finish(notReady);
			socket.onclose = () => finish(notReady);
			socket.onmessage = ({ data }) => {
				try {
					const message = JSON.parse(String(data)) as Record<string, unknown>;
					finish(
						message.type === "ready"
							? { ready: true, engines: parseEngines(message.engines) }
							: notReady,
					);
				} catch {
					finish(notReady);
				}
			};
		});
	} catch {
		return { ready: false };
	}
}

export async function selectVoiceEngine(
	voiceToken = process.env.SIDECAR_VOICE_TOKEN,
	options: SelectVoiceEngineOptions = {},
): Promise<VoiceEngine> {
	if (options.fake ?? process.env.SIDECAR_FAKE === "1") return { kind: "fake" };
	if (voiceToken) {
		const url = new URL(
			options.url ?? `ws://127.0.0.1:${options.port ?? LOCAL_PORT}`,
		);
		url.searchParams.set("token", voiceToken);
		const key = url.toString();
		const now = Date.now();
		const cached = probes.get(key);
		const probe =
			cached && cached.expires > now
				? cached
				: await localReady(key).then((result) => {
						probes.set(key, {
							...result,
							expires: now + (options.cacheMs ?? PROBE_CACHE_MS),
						});
						return result;
					});
		if (probe.ready) {
			if (probe.engines) localEngines.set(key, probe.engines);
			return { kind: "local", wsUrl: key };
		}
	}
	return (options.allowRealtime ??
		process.env.SIDECAR_VOICE_REALTIME === "1") &&
		process.env.OPENAI_API_KEY
		? { kind: "realtime" }
		: { kind: "none" };
}

/**
 * Engines a voice engine offers, for `GET /voice` and the ready frame.
 * Local engines report what the worker's ready frame listed during the probe.
 */
export function voiceEngines(engine: VoiceEngine): VoiceEngines {
	if (engine.kind === "fake")
		return { stt: [...FAKE_ENGINES.stt], tts: [...FAKE_ENGINES.tts] };
	if (engine.kind === "realtime")
		return { stt: ["openai-realtime"], tts: ["openai-realtime"] };
	if (engine.kind === "local") {
		const engines = localEngines.get(engine.wsUrl);
		return engines
			? { stt: [...engines.stt], tts: [...engines.tts] }
			: { stt: [], tts: [] };
	}
	return { stt: [], tts: [] };
}

export function realtimeRequest(input: VoiceInput): object {
	if (input.type === "configure")
		return { type: "session.update", session: {} };
	if (input.type === "audio")
		return { type: "input_audio_buffer.append", audio: input.pcm_b16 };
	if (input.type === "speak")
		return {
			type: "response.create",
			response: { modalities: ["audio"], instructions: input.text },
		};
	if (input.type === "interrupt") return { type: "response.cancel" };
	return {
		type:
			input.type === "listen_start"
				? "input_audio_buffer.clear"
				: "input_audio_buffer.commit",
	};
}

export function realtimeOutputEvents(
	value: unknown,
	id = "realtime",
): VoiceEvent[] {
	const message = object(value);
	const type = string(message?.type);
	if (!type) return [];
	if (type === "input_audio_buffer.speech_started")
		return [{ type: "vad", speech: true }];
	if (type === "input_audio_buffer.speech_stopped")
		return [{ type: "vad", speech: false }];
	if (type === "conversation.item.input_audio_transcription.completed")
		return typeof message?.transcript === "string"
			? [{ type: "transcript", final: true, text: message.transcript }]
			: [];
	if (type === "response.created") return [{ type: "tts_started", id }];
	if (type === "response.audio.delta" || type === "response.output_audio.delta")
		return typeof message?.delta === "string"
			? [{ type: "tts_audio", id, pcm_b16: message.delta }]
			: [];
	if (type === "response.audio.done" || type === "response.output_audio.done")
		return [{ type: "tts_stopped", id, reason: "complete" }];
	if (type === "response.done")
		return [
			{
				type: "tts_stopped",
				id,
				reason:
					object(message?.response)?.status === "cancelled"
						? "interrupted"
						: "complete",
			},
		];
	return [];
}

export function localOutputEvents(value: unknown): VoiceEvent[] {
	const message = object(value);
	const type = string(message?.type);
	const id = string(message?.id);
	if (type === "ready") {
		const engines = parseEngines(message?.engines);
		return [
			{
				type,
				vad: string(message?.vad),
				tts: string(message?.tts),
				...(engines ? { engines } : {}),
			},
		];
	}
	if (type === "vad" && typeof message?.speech === "boolean")
		return [{ type, speech: message.speech }];
	if (type === "transcript" && typeof message?.text === "string")
		return [{ type, final: message.final !== false, text: message.text }];
	if (type === "tts_started" && id) return [{ type, id }];
	if (type === "tts_audio" && id && typeof message?.pcm_b16 === "string")
		return [{ type, id, pcm_b16: message.pcm_b16 }];
	if (type === "tts_stopped" && id)
		return [{ type, id, reason: string(message?.reason) }];
	return [];
}

async function connect(
	url: string,
	handlers: VoiceHandlers,
	headers?: Record<string, string>,
): Promise<WebSocket> {
	let socket: WebSocket;
	try {
		socket = headers
			? new WebSocket(url, { headers } as unknown as string[])
			: new WebSocket(url);
	} catch (error) {
		throw new VoiceBridgeError(
			`Voice connection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return await new Promise<WebSocket>((resolve, reject) => {
		let settled = false;
		const finish = (error?: VoiceBridgeError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) {
				socket.close();
				handlers.onError?.(error);
				reject(error);
			} else resolve(socket);
		};
		const timeout = setTimeout(
			() =>
				finish(new VoiceBridgeError(`Voice connection to ${url} timed out.`)),
			CONNECT_TIMEOUT_MS,
		);
		timeout.unref();
		socket.onopen = () => finish();
		socket.onerror = () => {
			const error = new VoiceBridgeError(`Voice connection to ${url} failed.`);
			if (!settled) finish(error);
			else handlers.onError?.(error);
		};
		socket.onclose = () => {
			if (!settled)
				finish(new VoiceBridgeError(`Voice connection to ${url} closed.`));
		};
	});
}

function socketBridge(
	socket: WebSocket,
	available: boolean,
	encode: (input: VoiceInput) => object,
): VoiceBridge {
	const send = (input: VoiceInput) =>
		socket.send(JSON.stringify(encode(input)));
	return {
		available,
		listenStart: () => send({ type: "listen_start" }),
		listenStop: () => send({ type: "listen_stop" }),
		audio: (pcm_b16) => send({ type: "audio", pcm_b16 }),
		speak: (id, text, voice) => send({ type: "speak", id, text, voice }),
		interrupt: () => send({ type: "interrupt" }),
		close: () => socket.close(),
	};
}

export async function createVoiceBridge(
	engine: VoiceEngine,
	handlers: VoiceHandlers = {},
): Promise<VoiceBridge> {
	if (engine.kind === "none") {
		handlers.onError?.(
			new VoiceUnavailableError("No voice engine is available."),
		);
		const unavailable = () =>
			handlers.onError?.(
				new VoiceUnavailableError("No voice engine is available."),
			);
		return {
			available: false,
			listenStart: unavailable,
			listenStop: unavailable,
			audio: unavailable,
			speak: unavailable,
			interrupt: unavailable,
			close() {},
		};
	}
	if (engine.kind === "fake") return createFakeVoiceBridge(handlers);
	if (engine.kind === "local") {
		const socket = await connect(engine.wsUrl, handlers);
		socket.onmessage = ({ data }) => {
			try {
				for (const event of localOutputEvents(JSON.parse(String(data))))
					handlers.onEvent?.(event);
			} catch {
				handlers.onError?.(
					new VoiceBridgeError("Voice worker sent invalid JSON."),
				);
			}
		};
		return {
			...socketBridge(socket, true, (input) => input),
			configure: (engines) =>
				socket.send(JSON.stringify({ type: "configure", ...engines })),
		};
	}
	const key = process.env.OPENAI_API_KEY;
	if (!key)
		throw new VoiceUnavailableError(
			"OPENAI_API_KEY is required for OpenAI Realtime.",
		);
	const socket = await connect(
		"wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
		handlers,
		{ Authorization: `Bearer ${key}`, "OpenAI-Beta": "realtime=v1" },
	);
	socket.send(
		JSON.stringify({
			type: "session.update",
			session: {
				input_audio_transcription: { model: "whisper-1" },
				turn_detection: {
					type: "server_vad",
					create_response: false,
					interrupt_response: true,
				},
			},
		}),
	);
	const pending: string[] = [];
	const active = new Map<string, string>();
	socket.onmessage = ({ data }) => {
		try {
			const message = JSON.parse(String(data)) as Record<string, unknown>;
			const response = object(message.response);
			const responseId = string(response?.id) ?? string(message.response_id);
			if (message.type === "response.created" && responseId)
				active.set(responseId, pending.shift() ?? responseId);
			const id = responseId
				? (active.get(responseId) ?? responseId)
				: (pending[0] ?? "realtime");
			for (const event of realtimeOutputEvents(message, id))
				handlers.onEvent?.(event);
			if (
				(message.type === "response.done" ||
					message.type === "response.audio.done" ||
					message.type === "response.output_audio.done") &&
				responseId
			)
				active.delete(responseId);
			if (
				message.type === "error" ||
				message.type === "conversation.item.input_audio_transcription.failed"
			)
				handlers.onError?.(
					new VoiceBridgeError(
						string(object(message.error)?.message) ??
							"OpenAI Realtime returned an error.",
					),
				);
		} catch {
			handlers.onError?.(
				new VoiceBridgeError("OpenAI Realtime sent invalid JSON."),
			);
		}
	};
	const bridge = socketBridge(socket, true, realtimeRequest);
	return {
		...bridge,
		speak: (id, text, voice) => {
			pending.push(id);
			bridge.speak(id, text, voice);
		},
	};
}
