import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionEvent, SessionInfo } from "../ingest/events.ts";
import {
	normalizeClaudeRecord,
	normalizeCodexRecord,
} from "../ingest/harness.ts";
import {
	type Candidate,
	type Harness,
	harnessForPath,
	listCandidates,
} from "../ingest/manager.ts";
import { normalizePiRecord } from "../ingest/pi-jsonl.ts";
import type { Clock } from "../ports/clock.ts";
import type { SessionDetail, SessionSummary } from "../protocol.ts";
import type {
	BoundSession,
	PrivacyGate,
	SessionsService,
} from "../services.ts";

export const LIVE_WINDOW_MS = 2 * 60_000;
export const FOLLOW_DEBOUNCE_MS = 10_000;
export const RECEIPT_HISTORY = 200;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
/** Unbound sessions whose tails are prefetched for `searchAcross`. */
const PREFETCH_SESSIONS = 20;

export type Receipt = SessionDetail["receipts"][number];
export type SessionMeta = {
	sessionId?: string;
	project?: string;
	cwd?: string;
};
type Normalized = { events: SessionEvent[]; session?: SessionInfo };
type ConcreteHarness = Exclude<Harness, "auto">;

function normalizerFor(harness: string): (value: unknown) => Normalized {
	if (harness === "codex") return normalizeCodexRecord;
	if (harness === "claude") return normalizeClaudeRecord;
	return (value) =>
		value && typeof value === "object"
			? normalizePiRecord(value as Parameters<typeof normalizePiRecord>[0])
			: { events: [] };
}

/** One Tier-0 receipt line from a normalized (already sieved) event. */
export function toReceipt(event: SessionEvent): Receipt {
	const detail =
		event.event_type === "tool_result" || event.event_type === "tool_call"
			? event.details.split(/\r?\n/, 1)[0]?.slice(0, 160)
			: undefined;
	const text =
		detail && !event.headline.includes(detail)
			? `${event.headline} | ${detail}`
			: event.headline;
	return {
		at: event.timestamp,
		text,
		kind: event.event_type,
		...(event.is_error ? { isError: true } : {}),
	};
}

/** Read-only byte-range read; never opens a session file for writing. */
async function readRange(
	path: string,
	from: "head" | "tail",
	bytes: number,
): Promise<string> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(bytes, size);
		const position = from === "head" ? 0 : size - length;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, position);
		let text = buffer.toString("utf8");
		// Drop the partial line at the cut edge.
		if (from === "tail" && position > 0)
			text = text.slice(text.indexOf("\n") + 1);
		if (from === "head" && length < size)
			text = text.slice(0, text.lastIndexOf("\n") + 1);
		return text;
	} finally {
		await handle.close();
	}
}

function parseLines(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// partial or corrupt line
		}
	}
	return out;
}

/** Session id, project and cwd from the head of a session JSONL. */
export async function readSessionMeta(
	path: string,
	harness: string,
): Promise<SessionMeta> {
	let text = "";
	try {
		text = await readRange(path, "head", HEAD_BYTES);
	} catch {
		return {};
	}
	const normalize = normalizerFor(harness);
	const meta: SessionMeta = {};
	for (const record of parseLines(text)) {
		const session = normalize(record).session;
		if (session) {
			meta.sessionId ??= session.id;
			meta.project ??= session.project_name;
			meta.cwd ??= session.cwd;
		}
		// Claude Code stamps cwd/sessionId on every record.
		if (record && typeof record === "object") {
			const raw = record as Record<string, unknown>;
			if (typeof raw.cwd === "string") meta.cwd ??= raw.cwd;
			if (typeof raw.sessionId === "string") meta.sessionId ??= raw.sessionId;
		}
		if (meta.cwd && meta.sessionId) break;
	}
	meta.project ??= meta.cwd ? basename(meta.cwd) : undefined;
	return meta;
}

/** Recent Tier-0 receipts from the tail of a session file (read-only). */
export async function tailReceipts(
	path: string,
	harness: string,
	limit = RECEIPT_HISTORY,
): Promise<Receipt[]> {
	let text = "";
	try {
		text = await readRange(path, "tail", TAIL_BYTES);
	} catch {
		return [];
	}
	const normalize = normalizerFor(harness);
	const receipts: Receipt[] = [];
	for (const record of parseLines(text))
		for (const event of normalize(record).events)
			receipts.push(toReceipt(event));
	return receipts.slice(-limit);
}

/**
 * Follow-active debounce: a different session must stay the most recently
 * written one for `debounceMs` before the binding moves to it.
 */
export class FollowBinder {
	#pending?: { path: string; since: number };
	constructor(
		private readonly clock: Pick<Clock, "now">,
		private readonly debounceMs = FOLLOW_DEBOUNCE_MS,
	) {}

	reset(): void {
		this.#pending = undefined;
	}

	/** The path to rebind to now, if any. */
	decide(
		current: string,
		candidates: Array<Pick<Candidate, "path" | "modified">>,
	): string | undefined {
		let newest: Pick<Candidate, "path" | "modified"> | undefined;
		for (const candidate of candidates)
			if (!newest || candidate.modified > newest.modified) newest = candidate;
		if (!newest || newest.path === current) {
			this.#pending = undefined;
			return undefined;
		}
		if (!current) {
			this.#pending = undefined;
			return newest.path;
		}
		const now = this.clock.now();
		if (this.#pending?.path !== newest.path)
			this.#pending = { path: newest.path, since: now };
		if (now - this.#pending.since < this.debounceMs) return undefined;
		this.#pending = undefined;
		return newest.path;
	}
}

/** The slice of IngestManager the sessions feature drives. */
export type IngestBinding = {
	readonly watchedPath: string;
	bind(path: string, harness?: Harness): Promise<void>;
	resumeAuto(): Promise<void>;
};

export type SessionNote = { concept: string; why?: string; at: string };

type Entry = Candidate & { meta?: SessionMeta; metaModified?: number };

export type SessionRegistryOptions = {
	directories: Record<Harness, string[]>;
	clock: Clock;
	ingest: IngestBinding;
	privacy?: () => PrivacyGate | undefined;
	follow?: boolean;
	debounceMs?: number;
};

/**
 * Candidate sessions across every harness directory, the pill's binding
 * (follow-active or pinned), and per-session Tier-0 receipt history.
 * Never writes inside a session directory.
 */
export class SessionRegistry implements SessionsService {
	#entries = new Map<string, Entry>();
	#receipts = new Map<string, Receipt[]>();
	#tailedAt = new Map<string, number>();
	#notes = new Map<string, SessionNote[]>();
	#follow: boolean;
	#binder: FollowBinder;

	constructor(private readonly options: SessionRegistryOptions) {
		this.#follow = options.follow ?? true;
		this.#binder = new FollowBinder(options.clock, options.debounceMs);
	}

	get follow(): boolean {
		return this.#follow;
	}

	get boundPath(): string {
		return this.options.ingest.watchedPath;
	}

	#privacy(): PrivacyGate | undefined {
		return this.options.privacy?.();
	}

	#harness(path: string): ConcreteHarness {
		return (this.#entries.get(path)?.harness ??
			harnessForPath(this.options.directories, path) ??
			"pi") as ConcreteHarness;
	}

	/** Rescan harness dirs, refresh metadata, prefetch tails, follow-rebind. */
	async refresh(): Promise<{ rebound: boolean }> {
		const candidates = await listCandidates(this.options.directories, "auto");
		const seen = new Set<string>();
		for (const candidate of candidates) {
			seen.add(candidate.path);
			const entry: Entry = {
				...this.#entries.get(candidate.path),
				...candidate,
			};
			// Session files are append-only: once the head yielded an id it never
			// changes, so re-read only until it does.
			if (
				!entry.meta ||
				(!entry.meta.sessionId && entry.metaModified !== candidate.modified)
			) {
				entry.meta = await readSessionMeta(candidate.path, candidate.harness);
				entry.metaModified = candidate.modified;
			}
			this.#entries.set(candidate.path, entry);
			const privacy = this.#privacy() as
				| (PrivacyGate & { linkSessionCwd?(path: string, cwd: string): void })
				| undefined;
			if (entry.meta?.cwd)
				privacy?.linkSessionCwd?.(candidate.path, entry.meta.cwd);
		}
		for (const path of this.#entries.keys())
			if (!seen.has(path) && !path.startsWith("fake/"))
				this.#entries.delete(path);
		await this.#prefetch();
		return { rebound: await this.#followTick() };
	}

	async #prefetch(): Promise<void> {
		const recent = [...this.#entries.values()]
			.sort((a, b) => b.modified - a.modified)
			.slice(0, PREFETCH_SESSIONS);
		for (const entry of recent) {
			if (entry.path === this.boundPath) continue;
			if (this.#privacy()?.isLocalOnly(entry.path)) continue;
			if (this.#tailedAt.get(entry.path) === entry.modified) continue;
			await this.#loadTail(entry.path);
			this.#tailedAt.set(entry.path, entry.modified);
		}
	}

	async #loadTail(path: string): Promise<void> {
		const receipts = await tailReceipts(path, this.#harness(path));
		if (receipts.length) this.#receipts.set(path, receipts);
	}

	async #followTick(): Promise<boolean> {
		if (!this.#follow) return false;
		const target = this.#binder.decide(this.boundPath, [
			...this.#entries.values(),
		]);
		if (!target) return false;
		await this.options.ingest.bind(target, this.#harness(target));
		return true;
	}

	/** `null` returns to follow-active; a path pins the binding to it. */
	async bind(sessionPath: string | null): Promise<void> {
		this.#binder.reset();
		if (sessionPath === null) {
			this.#follow = true;
			const newest = [...this.#entries.values()].sort(
				(a, b) => b.modified - a.modified,
			)[0];
			if (newest && newest.path !== this.boundPath)
				await this.options.ingest.bind(newest.path, newest.harness);
			else if (!newest) await this.options.ingest.resumeAuto();
			return;
		}
		if (!this.#entries.has(sessionPath))
			throw new Error("Unknown watched session");
		this.#follow = false;
		await this.options.ingest.bind(sessionPath, this.#harness(sessionPath));
	}

	/** Record a Tier-0 receipt from an ingested event of the bound session. */
	observe(event: SessionEvent): void {
		const path = event.session_file ?? this.boundPath;
		if (!path) return;
		if (path.startsWith("fake/"))
			this.#entries.set(path, {
				path,
				harness: "pi",
				modified: this.options.clock.now(),
				meta: { sessionId: "fake", project: "Order consumer" },
			});
		const list = this.#receipts.get(path) ?? [];
		list.push(toReceipt(event));
		if (list.length > RECEIPT_HISTORY)
			list.splice(0, list.length - RECEIPT_HISTORY);
		this.#receipts.set(path, list);
	}

	/** An MCP tutor_note for the bound session. */
	recordNote(
		note: { concept: string; why?: string },
		path = this.boundPath,
	): void {
		if (!path) return;
		if (path.startsWith("fake/"))
			this.#entries.set(path, {
				path,
				harness: "pi",
				modified: this.options.clock.now(),
				meta: { sessionId: "fake", project: "Order consumer" },
			});
		const list = this.#notes.get(path) ?? [];
		list.push({
			concept: note.concept,
			...(note.why ? { why: note.why } : {}),
			at: new Date(this.options.clock.now()).toISOString(),
		});
		if (list.length > RECEIPT_HISTORY)
			list.splice(0, list.length - RECEIPT_HISTORY);
		this.#notes.set(path, list);
	}

	notes(path: string): SessionNote[] {
		return [...(this.#notes.get(path) ?? [])];
	}

	meta(path: string): SessionMeta | undefined {
		return this.#entries.get(path)?.meta;
	}

	summary(path: string): SessionSummary {
		const entry = this.#entries.get(path);
		const privacy = this.#privacy();
		const modified = entry?.modified ?? 0;
		return {
			path,
			harness: entry?.harness ?? this.#harness(path),
			...(entry?.meta?.project ? { project: entry.meta.project } : {}),
			modified,
			live: this.options.clock.now() - modified <= LIVE_WINDOW_MS,
			localOnly: privacy?.isLocalOnly(path) ?? false,
			indexGraph: privacy?.indexIntoGraph(path) ?? true,
			bound: path === this.boundPath,
			noteCount: this.#notes.get(path)?.length ?? 0,
		};
	}

	/** Newest first. */
	list(): SessionSummary[] {
		return [...this.#entries.values()]
			.sort((a, b) => b.modified - a.modified)
			.map((entry) => this.summary(entry.path));
	}

	/** Receipt history, tail-reading the file when nothing was observed yet. */
	async receiptHistory(
		path: string,
		limit = RECEIPT_HISTORY,
	): Promise<Receipt[]> {
		if (!this.#receipts.has(path) && this.#entries.has(path))
			await this.#loadTail(path);
		return (this.#receipts.get(path) ?? []).slice(-limit);
	}

	/* ---- SessionsService ---- */

	bound(): BoundSession | undefined {
		const path = this.boundPath;
		if (!path) return undefined;
		const entry = this.#entries.get(path);
		return {
			path,
			harness: entry?.harness ?? this.#harness(path),
			...(entry?.meta?.sessionId ? { sessionId: entry.meta.sessionId } : {}),
			...(entry?.meta?.project ? { project: entry.meta.project } : {}),
			follow: this.#follow,
		};
	}

	receipts(path?: string, limit = 20): string[] {
		const target = path ?? this.boundPath;
		return (this.#receipts.get(target) ?? [])
			.slice(-limit)
			.map((receipt) => receipt.text);
	}

	searchAcross(
		text: string,
		limit = 20,
	): Array<{ path: string; receipt: string }> {
		const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) return [];
		const privacy = this.#privacy();
		const hits: Array<{ path: string; receipt: string; at: string }> = [];
		for (const [path, receipts] of this.#receipts) {
			if (privacy?.isLocalOnly(path)) continue;
			for (const receipt of receipts) {
				const haystack = receipt.text.toLowerCase();
				if (terms.every((term) => haystack.includes(term)))
					hits.push({ path, receipt: receipt.text, at: receipt.at });
			}
		}
		return hits
			.sort((a, b) => b.at.localeCompare(a.at))
			.slice(0, limit)
			.map(({ path, receipt }) => ({ path, receipt }));
	}
}
