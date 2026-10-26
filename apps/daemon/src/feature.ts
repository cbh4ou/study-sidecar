import type { ActivityRegistry } from "./activity.ts";
import type { SessionEvent, SessionInfo } from "./ingest/events.ts";
import type { Clock } from "./ports/clock.ts";
import type { DecidePort } from "./ports/decide.ts";
import type { LlmPort } from "./ports/llm.ts";
import type { WebSearchPort } from "./ports/web.ts";
import type { ClientMessage, DaemonMessage } from "./protocol.ts";
import type { Services } from "./services.ts";
import type { SettingsStore } from "./settings.ts";
import type { TutorEngine } from "./tutor/engine.ts";

export type Ports = {
	llm: LlmPort;
	decide: DecidePort;
	web: WebSearchPort;
	clock: Clock;
};

/** Everything a feature may use. Built once in index.ts. */
export type DaemonContext = {
	/** User home (for watched harness dirs). */
	home: string;
	/** Sidecar root (`~/.study-sidecar` or `SIDECAR_HOME`); sole write area. */
	root: string;
	/** `SIDECAR_FAKE=1` / `--fake`: every port is a fake. */
	fake: boolean;
	broadcast(message: DaemonMessage): void;
	ports: Ports;
	settings: SettingsStore;
	activity: ActivityRegistry;
	services: Services;
	/** The existing tutor engine (owns the pi-durable deep-lane harness). */
	tutor: TutorEngine;
	/** Recent events from the currently ingested session (newest last). */
	events(): SessionEvent[];
	session(): SessionInfo | undefined;
	/** Path of the JSONL currently tailed by IngestManager. */
	watchedPath(): string;
	/** Feed a synthetic SessionEvent through the normal ingest path (fake replay). */
	ingestEvent(event: SessionEvent): void;
	/** Run a ClientMessage through every feature as if a desktop sent it (MCP). */
	dispatch(message: ClientMessage): Promise<boolean>;
};

export type RouteResult = Response | undefined | Promise<Response | undefined>;

/**
 * A daemon feature module. index.ts calls each hook in registration order;
 * the first `route` returning a Response wins, every `onClientMessage` sees
 * every message (return true when handled), `onEvent` sees every ingested
 * SessionEvent, and `onConnect` lets a feature send initial state to a new
 * desktop socket. Auth, CORS preflight and host checks happen before routes.
 */
export interface Feature {
	readonly name: string;
	start?(): Promise<void> | void;
	stop?(): Promise<void> | void;
	route?(request: Request, url: URL, cors: Record<string, string>): RouteResult;
	onClientMessage?(
		message: ClientMessage,
	): Promise<boolean | undefined> | boolean | undefined;
	onEvent?(event: SessionEvent): void;
	onConnect?(send: (message: DaemonMessage) => void): void;
}

export type FeatureFactory = (context: DaemonContext) => Feature;

/** JSON response helper shared by feature routes. */
export function json(
	data: unknown,
	cors: Record<string, string> = {},
	status = 200,
): Response {
	return Response.json(data, { status, headers: cors });
}

/** Parse a JSON request body, or undefined when malformed. */
export async function readBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}
