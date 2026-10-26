import type { DaemonContext, Feature } from "../feature.ts";
import { json } from "../feature.ts";
import { type Harness, sessionDirectories } from "../ingest/manager.ts";
import type {
	GraphSnapshot,
	Lesson,
	Proposition,
	SessionDetail,
	SourceRef,
} from "../protocol.ts";
import {
	type IngestBinding,
	type SessionMeta,
	type SessionNote,
	SessionRegistry,
} from "./registry.ts";

export const REFRESH_MS = 5_000;

/** Optional LearnService extensions, duck-typed so learn/ may omit them. */
type LearnExtras = {
	recentNotes?(
		limit?: number,
	): Promise<
		Array<{ concept: string; why?: string; at: string; source?: SourceRef }>
	>;
	listLessons?(): Promise<Lesson[]>;
};

export type AcrossSession = { id: string; name: string; sessions: string[] };

/** Stable key for a session SourceRef: its file when known, else harness:id. */
function sessionKey(
	ref: SourceRef,
	byId: Map<string, string>,
): string | undefined {
	if (ref.kind !== "session") return undefined;
	if (ref.file) return ref.file;
	return byId.get(ref.sessionId) ?? `${ref.harness}:${ref.sessionId}`;
}

function refMatches(
	ref: SourceRef | undefined,
	path: string,
	meta: SessionMeta | undefined,
): boolean {
	if (ref?.kind !== "session") return false;
	if (ref.file) return ref.file === path;
	return Boolean(meta?.sessionId) && ref.sessionId === meta?.sessionId;
}

/** Propositions whose sources span 2+ distinct sessions. */
export function acrossSessions(
	snapshot: Pick<GraphSnapshot, "nodes">,
	sessionIds: Map<string, string> = new Map(),
): AcrossSession[] {
	const out: AcrossSession[] = [];
	for (const node of snapshot.nodes) {
		const sessions = new Set<string>();
		for (const ref of node.sources) {
			const key = sessionKey(ref, sessionIds);
			if (key) sessions.add(key);
		}
		if (sessions.size >= 2)
			out.push({
				id: node.id,
				name: node.name,
				sessions: [...sessions].sort(),
			});
	}
	return out;
}

export type SessionsFeatureOptions = {
	directories?: Record<Harness, string[]>;
	refreshMs?: number;
	debounceMs?: number;
};

/**
 * Multi-session binding (spec 4.2). Needs the daemon's IngestManager (or
 * anything with `watchedPath`, `bind`, `resumeAuto`) to retarget the tailer.
 */
export function createSessionsFeature(
	context: DaemonContext,
	ingest: IngestBinding,
	options: SessionsFeatureOptions = {},
): Feature & { registry: SessionRegistry } {
	const registry = new SessionRegistry({
		directories: options.directories ?? sessionDirectories(context.home),
		clock: context.ports.clock,
		ingest,
		privacy: () => context.services.privacy,
		follow: context.settings.value.follow,
		debounceMs: options.debounceMs,
	});
	context.services.sessions = registry;
	let timer: unknown;
	let stopped = false;
	let lastPaths = "";
	let unsubscribe: (() => void) | undefined;

	const announceBound = () => {
		const path = registry.boundPath;
		if (path)
			context.broadcast({
				type: "bound_session",
				sessionPath: path,
				follow: registry.follow,
			});
	};

	const tick = async () => {
		if (stopped) return;
		try {
			const { rebound } = await registry.refresh();
			const paths = registry
				.list()
				.map((session) => `${session.path}:${session.live}`)
				.join("|");
			if (rebound) announceBound();
			if (rebound || paths !== lastPaths)
				context.broadcast({ type: "sessions_changed" });
			lastPaths = paths;
		} catch (error) {
			console.error("sessions refresh failed:", error);
		}
		if (!stopped)
			timer = context.ports.clock.setTimeout(
				() => void tick(),
				options.refreshMs ?? REFRESH_MS,
			);
	};

	const sessionIds = () => {
		const map = new Map<string, string>();
		for (const session of registry.list()) {
			const id = registry.meta(session.path)?.sessionId;
			if (id) map.set(id, session.path);
		}
		return map;
	};

	async function snapshot(): Promise<GraphSnapshot | undefined> {
		try {
			return await context.services.graph?.snapshot();
		} catch {
			return undefined;
		}
	}

	async function detail(path: string): Promise<SessionDetail> {
		const meta = registry.meta(path);
		const learn = context.services.learn as
			| (NonNullable<DaemonContext["services"]["learn"]> & LearnExtras)
			| undefined;
		const notes: SessionNote[] = registry.notes(path);
		if (typeof learn?.recentNotes === "function") {
			try {
				for (const note of await learn.recentNotes(200))
					if (
						refMatches(note.source, path, meta) &&
						// The registry already holds MCP notes it saw; skip their echo.
						!notes.some(
							(existing) =>
								existing.concept === note.concept &&
								(existing.why ?? "") === (note.why ?? ""),
						)
					)
						notes.push({
							concept: note.concept,
							...(note.why ? { why: note.why } : {}),
							at: note.at,
						});
			} catch {
				// learn notes are best effort
			}
		}
		const graph = await snapshot();
		const concepts = (graph?.nodes ?? [])
			.filter((node: Proposition) =>
				node.sources.some((ref) => refMatches(ref, path, meta)),
			)
			.map((node) => ({ id: node.id, name: node.name }));
		let anchors: SourceRef[] = [];
		if (typeof learn?.listLessons === "function") {
			try {
				anchors = (await learn.listLessons())
					.filter((lesson) => lesson.sessionPath === path)
					.flatMap((lesson) => lesson.anchors);
			} catch {
				anchors = [];
			}
		}
		return {
			summary: registry.summary(path),
			receipts: await registry.receiptHistory(path),
			notes: notes.sort((a, b) => a.at.localeCompare(b.at)),
			concepts,
			anchors,
		};
	}

	return {
		name: "sessions",
		registry,
		async start() {
			await tick();
			unsubscribe = context.settings.onChange((value) => {
				if (value.follow === registry.follow) return;
				void registry
					.followActive(value.follow)
					.then(() => {
						announceBound();
						context.broadcast({ type: "sessions_changed" });
					})
					.catch((error) =>
						context.broadcast({
							type: "error",
							message: `Could not change session binding: ${String(error)}`,
						}),
					);
			});
		},
		stop() {
			unsubscribe?.();
			stopped = true;
			if (timer !== undefined) context.ports.clock.clearTimeout(timer);
		},
		onEvent(event) {
			registry.observe(event);
		},
		onConnect(send) {
			const path = registry.boundPath;
			if (path)
				send({
					type: "bound_session",
					sessionPath: path,
					follow: registry.follow,
				});
		},
		async onClientMessage(message) {
			if (message.type !== "bind_session") return false;
			await registry.bind(message.sessionPath);
			await context.settings.update({ follow: registry.follow });
			announceBound();
			context.broadcast({ type: "sessions_changed" });
			return true;
		},
		async route(request, url, cors) {
			if (request.method !== "GET") return undefined;
			if (url.pathname === "/api/sessions") {
				const graph = await snapshot();
				return json(
					{
						sessions: registry.list(),
						follow: registry.follow,
						bound: registry.boundPath || null,
						acrossSessions: graph ? acrossSessions(graph, sessionIds()) : [],
					},
					cors,
				);
			}
			if (url.pathname === "/api/sessions/detail") {
				const path = url.searchParams.get("path");
				if (!path) return json({ error: "path is required" }, cors, 400);
				if (!registry.list().some((session) => session.path === path))
					return json({ error: "unknown session" }, cors, 404);
				return json(await detail(path), cors);
			}
			return undefined;
		},
	};
}
