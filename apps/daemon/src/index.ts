import type { ServerWebSocket } from "bun";
import { ActivityRegistry } from "./activity.ts";
import { createPorts } from "./adapters/index.ts";
import {
	corsHeaders,
	DEFAULT_PORT,
	generateToken,
	hostAllowed,
	requestToken,
	tokenEquals,
} from "./auth.ts";
import type { DaemonContext, Feature } from "./feature.ts";
import { createFeatures } from "./features.ts";
import type { SessionEvent, SessionInfo } from "./ingest/events.ts";
import {
	type Harness,
	IngestManager,
	sessionDirectories,
} from "./ingest/manager.ts";
import { createDeepTools } from "./lanes/tools.ts";
import type { Learn } from "./learn/service.ts";
import { learnTools } from "./learn/tools.ts";
import { OKFStore } from "./memory/okf-store.ts";
import { loadModes } from "./modes/modes.ts";
import { sidecarHome } from "./paths.ts";
import {
	type ClientMessage,
	type DaemonMessage,
	parseClientMessage,
	type TutorDocuments,
} from "./protocol.ts";
import { SettingsStore } from "./settings.ts";
import { TutorEngine, type TutorMessage } from "./tutor/engine.ts";
import { saveTutorModel, selectTutorModel } from "./tutor/model-selection.ts";
import {
	createVoiceBridge,
	selectVoiceEngine,
	type VoiceBridge,
	type VoiceEngine,
	voiceEngines,
} from "./voice/router.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const harness = option("--harness", "auto") as Harness;
const port = Number(option("--port", String(DEFAULT_PORT)));
const deadAirSeconds = Number(option("--dead-air-seconds", "15"));
const home = process.env.HOME ?? "";
const fake = args.includes("--fake") || process.env.SIDECAR_FAKE === "1";
if (fake) process.env.SIDECAR_FAKE = "1";
const root = sidecarHome(home);
const settings = new SettingsStore(root);
await settings.load();
const selection = await selectTutorModel(
	home,
	option("--model", process.env.SIDECAR_MODEL ?? "") || undefined,
);
let modelSlug = selection.model;
const availableModels = selection.models;
const directories = sessionDirectories(home);
let authToken = option("--token", "") || process.env.SIDECAR_TOKEN || "";
if (!authToken) {
	authToken = generateToken();
	console.log(`sidecar token: ${authToken}`);
}
const voiceToken =
	option("--voice-token", "") || process.env.SIDECAR_VOICE_TOKEN || "";

const MAX_WS_CLIENTS = 4;
const MAX_FRAME_BYTES = 64 * 1024;
type SocketData =
	| { kind: "daemon" }
	| { kind: "voice"; engine: VoiceEngine; bridge?: VoiceBridge };
const clients = new Set<ServerWebSocket<SocketData>>();
const events: SessionEvent[] = [];
let voiceEngine: VoiceEngine = { kind: "none" };
const okfStore = new OKFStore();
let session: SessionInfo | undefined;
let documents: TutorDocuments | undefined;
let watched = "";
const modes = await loadModes();
const fallbackMode = [...modes.values()][0];
const mode =
	modes.get("socratic") ??
	modes.get("spotter") ??
	modes.get("co-pilot") ??
	fallbackMode;
if (
	!mode ||
	!directories[harness] ||
	!Number.isFinite(port) ||
	!Number.isFinite(deadAirSeconds)
) {
	throw new Error(
		`Usage: --harness pi|omp|codex|claude|auto --port ${DEFAULT_PORT} --dead-air-seconds 15 [--token <token>] [--model <provider/model>]`,
	);
}

function broadcast(message: DaemonMessage): void {
	const encoded = JSON.stringify(message);
	for (const client of clients) client.send(encoded);
}

const tutor = new TutorEngine(
	mode,
	(message: TutorMessage) => {
		if (message.type === "tutor_documents") documents = message.documents;
		broadcast(message);
	},
	{
		deadAirSeconds,
		modelSlug: settings.value.lanes.deep ?? modelSlug ?? "",
		extraTools: () => [
			...(context.services.learn
				? learnTools(context.services.learn as Learn)
				: []),
			...createDeepTools(context),
		],
		allowCloud: (path) =>
			!fake &&
			(!context.ports.llm.isCloud ||
				(context.services.privacy?.allowCloud(
					path ?? context.services.sessions?.bound()?.path ?? watched,
				) ??
					false)),
		decide: () => context.ports.decide,
		sourceScope: () =>
			context.services.learn?.activeLessonId() ??
			context.services.sessions?.bound()?.path ??
			watched,
	},
);
const activity = new ActivityRegistry((jobs) =>
	broadcast({ type: "activity", jobs }),
);
const context: DaemonContext = {
	home,
	root,
	fake,
	broadcast,
	ports: await createPorts({
		home,
		root,
		fake,
		settings,
		modelSlug: modelSlug ?? undefined,
	}),
	settings,
	activity,
	services: {},
	tutor,
	events: () => events,
	session: () => session,
	watchedPath: () => watched,
	ingestEvent: (event) => {
		if (fake && !watched) {
			watched = event.session_file ?? "fake/session.jsonl";
			setSession({ id: "fake", project_name: "Order consumer" });
		}
		addEvent(event);
	},
	dispatch: (message) => dispatchClientMessage(message),
};
const ingest = new IngestManager(
	{
		onEvent: addEvent,
		onSession: setSession,
		broadcast,
		reset: () => {
			events.length = 0;
			session = undefined;
			tutor.reset();
		},
		watched: (path) => {
			watched = path;
		},
		hydrate: (value) => {
			tutor.hydrating = value;
		},
	},
	{ harness, directories, durableUrl: process.env.DURABLE_URL },
);
const features: Feature[] = createFeatures(
	context,
	fake
		? {
				get watchedPath() {
					return watched;
				},
				async bind(path) {
					watched = path;
					setSession({ id: "fake", project_name: "Order consumer" });
				},
				async resumeAuto() {},
			}
		: ingest,
);
settings.onChange((value) => {
	void tutor.setModel(value.lanes.deep ?? modelSlug ?? "");
});
async function dispatchClientMessage(message: ClientMessage): Promise<boolean> {
	let handled = false;
	if (message.type === "abort_job") {
		activity.abort(message.jobId);
		handled = true;
	}
	for (const feature of features) {
		try {
			if (await feature.onClientMessage?.(message)) handled = true;
		} catch (error) {
			broadcast({
				type: "daemon_error",
				scope: "provider",
				message: `${feature.name}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return handled;
}
function addEvent(event: SessionEvent): void {
	events.push(event);
	if (events.length > 100) events.shift();
	broadcast({ type: "new_event", event });
	if (
		!fake &&
		(!context.ports.llm.isCloud ||
			context.services.privacy?.allowCloud(watched))
	)
		tutor.observe(event);
	for (const feature of features) {
		try {
			feature.onEvent?.(event);
		} catch (error) {
			console.error(`feature ${feature.name} onEvent failed:`, error);
		}
	}
}
function setSession(next: SessionInfo): void {
	session = next;
	context.services.privacy?.linkSource?.(next.id, watched);
	tutor.setSession(next);
	broadcast({
		type: "session_init",
		session_id: next.id,
		project_name: next.project_name,
		current_goal: next.current_goal,
		transcript_path: watched,
		events: events.slice(-30),
	});
}

const json = (
	data: unknown,
	headers: Record<string, string> = {},
	status = 200,
) => Response.json(data, { status, headers });

for (const feature of features) {
	try {
		await feature.start?.();
	} catch (error) {
		console.error(`feature ${feature.name} failed to start:`, error);
	}
}

const server = Bun.serve<SocketData>({
	port,
	hostname: "127.0.0.1",
	async fetch(request, server) {
		const url = new URL(request.url);
		const cors = corsHeaders(request.headers.get("origin"));
		if (!hostAllowed(request.headers.get("host"))) {
			return json({ error: "forbidden host" }, {}, 403);
		}
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors });
		}
		if (url.pathname === "/ws") {
			// Missing or wrong token must never reach the upgrade.
			if (!tokenEquals(requestToken(request), authToken)) {
				return json({ error: "unauthorized" }, {}, 403);
			}
			const origin = request.headers.get("origin");
			if (origin && !cors["Access-Control-Allow-Origin"]) {
				return json({ error: "forbidden origin" }, {}, 403);
			}
			if (server.upgrade(request, { data: { kind: "daemon" } })) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (url.pathname === "/voice-ws") {
			// The daemon is the only voice endpoint a desktop ever connects to;
			// worker and provider credentials stay behind this boundary.
			if (!tokenEquals(requestToken(request), authToken)) {
				return json({ error: "unauthorized" }, {}, 403);
			}
			if (
				server.upgrade(request, {
					data: { kind: "voice", engine: voiceEngine },
				})
			)
				return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (!tokenEquals(requestToken(request), authToken)) {
			return json({ error: "unauthorized" }, cors, 401);
		}
		if (url.pathname === "/health") {
			return json({ ok: true, watched: watched || null }, cors);
		}
		if (url.pathname === "/api/state") {
			return json(
				{
					watching: Boolean(watched),
					session: session?.id ?? null,
					mode: tutor.activeMode.name,
					model: modelSlug,
				},
				cors,
			);
		}
		if (url.pathname === "/api/models") {
			return json({ model: modelSlug, models: availableModels }, cors);
		}
		if (url.pathname === "/api/model" && request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json({ error: "body must be JSON" }, cors, 400);
			}
			const next = (body as { model?: unknown } | null)?.model;
			if (typeof next !== "string" || !availableModels.includes(next))
				return json({ error: "model is unavailable" }, cors, 400);
			await tutor.setModel(next);
			await saveTutorModel(home, next);
			modelSlug = next;
			return json({ model: next }, cors);
		}
		if (url.pathname === "/latest-steering") {
			return json({ prompt: tutor.latestSteering }, cors);
		}
		if (url.pathname === "/voice") {
			voiceEngine = await selectVoiceEngine(voiceToken, {
				fake,
				allowRealtime:
					settings.value.voice.stt === "openai-realtime" &&
					context.services.privacy?.allowCloud(watched) === true,
			});
			return json(
				{
					kind: voiceEngine.kind,
					ws_url:
						voiceEngine.kind === "none"
							? null
							: `ws://127.0.0.1:${server.port}/voice-ws`,
					engines: voiceEngines(voiceEngine),
				},
				cors,
			);
		}
		if (url.pathname === "/okf/save" && request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json({ error: "body must be JSON" }, cors, 400);
			}
			const payload = (body ?? {}) as {
				title?: unknown;
				body?: unknown;
				topics?: unknown;
				mermaid?: unknown;
				tool_use_id?: unknown;
			};
			if (
				typeof payload.title !== "string" ||
				!payload.title.trim() ||
				payload.title.length > 200
			) {
				return json({ error: "title must be 1-200 characters" }, cors, 400);
			}
			if (typeof payload.body !== "string" || payload.body.length > 20_000) {
				return json(
					{ error: "body must be at most 20000 characters" },
					cors,
					400,
				);
			}
			if (
				payload.topics !== undefined &&
				(!Array.isArray(payload.topics) ||
					payload.topics.length > 12 ||
					payload.topics.some((topic) => typeof topic !== "string"))
			) {
				return json({ error: "topics must be at most 12 strings" }, cors, 400);
			}
			if (
				payload.mermaid !== undefined &&
				(typeof payload.mermaid !== "string" || payload.mermaid.length > 20_000)
			) {
				return json(
					{ error: "mermaid must be at most 20000 characters" },
					cors,
					400,
				);
			}
			if (
				payload.tool_use_id !== undefined &&
				(typeof payload.tool_use_id !== "string" ||
					payload.tool_use_id.length > 200)
			) {
				return json(
					{ error: "tool_use_id must be at most 200 characters" },
					cors,
					400,
				);
			}
			const path = await okfStore.saveConcept(
				payload.title,
				payload.body,
				payload.topics as string[] | undefined,
				session?.id ?? "unknown",
				payload.mermaid as string | undefined,
				payload.tool_use_id as string | undefined,
			);
			return json({ path }, cors);
		}
		for (const feature of features) {
			const response = await feature.route?.(request, url, cors);
			if (response) return response;
		}
		return json({ error: "not found" }, cors, 404);
	},
	websocket: {
		open(socket) {
			const voice = socket.data;
			if (voice.kind === "voice") {
				void createVoiceBridge(voice.engine, {
					onEvent: (event) => socket.send(JSON.stringify(event)),
					onError: (error) =>
						socket.send(
							JSON.stringify({ type: "error", message: error.message }),
						),
				})
					.then((bridge) => {
						if (socket.readyState !== 1) {
							bridge.close();
							return;
						}
						voice.bridge = bridge;
						socket.send(
							JSON.stringify({
								type: "ready",
								vad: voice.engine.kind,
								tts: voice.engine.kind,
								engines: voiceEngines(voice.engine),
							}),
						);
					})
					.catch(() => socket.close(1011, "voice engine unavailable"));
				return;
			}
			if (clients.size >= MAX_WS_CLIENTS) {
				socket.close(1013, "client limit reached");
				return;
			}
			clients.add(socket);
			socket.send(
				JSON.stringify({
					type: "session_init",
					session_id: session?.id,
					project_name: session?.project_name,
					current_goal: session?.current_goal,
					transcript_path: watched,
					events: events.slice(-30),
				}),
			);
			socket.send(
				JSON.stringify({
					type: "modes",
					modes: [...modes.values()].map(
						({ name, title, description, voice }) => ({
							name,
							title,
							description,
							voice_profile:
								voice.language || voice.accent
									? `${voice.language ?? "en"}-${voice.accent ?? "default"}`
									: undefined,
						}),
					),
					active: tutor.activeMode.name,
				}),
			);
			if (documents)
				socket.send(JSON.stringify({ type: "tutor_documents", documents }));
			socket.send(JSON.stringify({ type: "activity", jobs: activity.list() }));
			for (const feature of features)
				feature.onConnect?.((message) => socket.send(JSON.stringify(message)));
		},
		async message(socket, value) {
			if (typeof value !== "string") return; // binary frames are ignored
			if (Buffer.byteLength(value) > MAX_FRAME_BYTES) {
				socket.send(
					JSON.stringify({ type: "error", message: "frame too large" }),
				);
				socket.close(1009, "frame too large");
				return;
			}
			if (socket.data.kind === "voice") {
				const bridge = socket.data.bridge;
				if (!bridge) return;
				try {
					const frame = JSON.parse(value) as Record<string, unknown>;
					if (frame.type === "listen_start") bridge.listenStart();
					else if (frame.type === "listen_stop") bridge.listenStop();
					else if (frame.type === "audio" && typeof frame.pcm_b16 === "string")
						bridge.audio(frame.pcm_b16);
					else if (
						frame.type === "speak" &&
						typeof frame.id === "string" &&
						typeof frame.text === "string"
					)
						bridge.speak(
							frame.id,
							frame.text,
							frame.voice && typeof frame.voice === "object"
								? (frame.voice as {
										language?: string;
										speed?: number;
										voice?: string;
									})
								: undefined,
						);
					else if (frame.type === "configure")
						bridge.configure?.({
							stt: typeof frame.stt === "string" ? frame.stt : undefined,
							tts: typeof frame.tts === "string" ? frame.tts : undefined,
						});
					else if (frame.type === "interrupt") bridge.interrupt();
				} catch {
					// malformed voice frames never touch daemon state
				}
				return;
			}
			try {
				const parsed = parseClientMessage(JSON.parse(value));
				if (!parsed) return;
				if (await dispatchClientMessage(parsed)) return;
				const incoming: unknown = parsed;
				if (
					!incoming ||
					typeof incoming !== "object" ||
					!("type" in incoming) ||
					typeof incoming.type !== "string"
				) {
					return;
				}
				if (
					incoming.type === "question" &&
					"text" in incoming &&
					typeof incoming.text === "string" &&
					incoming.text.trim()
				) {
					try {
						await tutor.answer(incoming.text);
					} catch (error) {
						broadcast({
							type: "daemon_error",
							scope: "provider",
							message: `your question could not be answered: ${error instanceof Error ? error.message : String(error)}`,
						});
					}
				}
				if (
					incoming.type === "set_mode" &&
					"name" in incoming &&
					typeof incoming.name === "string"
				) {
					const next = modes.get(incoming.name);
					if (!next) return;
					tutor.setMode(next);
					broadcast({ type: "mode_changed", name: next.name });
				}
			} catch {
				// malformed client messages never mutate daemon state
			}
		},
		close(socket) {
			if (socket.data.kind === "voice") {
				socket.data.bridge?.close();
				return;
			}
			clients.delete(socket);
		},
	},
});
console.log(`daemon listening on http://127.0.0.1:${server.port}`);

if (!fake) ingest.start();

// Close the durable harness on shutdown: a SIGKILL mid-commit is what leaves
// an unresumable task that replays duplicate entry IDs on the next open.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		ingest.stop();
		const stop = () => process.exit(0);
		void Promise.allSettled(features.map((feature) => feature.stop?.()))
			.then(() => tutor.close())
			.catch(() => undefined)
			.then(stop, stop);
	});
}
