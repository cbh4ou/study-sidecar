import type { SessionInfo, TailerCallbacks } from "./events.ts";
import {
	type EventEnrichmentState,
	enrichEvent,
	normalizePiRecord,
} from "./pi-jsonl.ts";

const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;

type SseFrame = { event: string; data: string };

function enrichmentState(file?: string): EventEnrichmentState {
	let counter = 0;
	return { file, seq: () => ++counter };
}

function emitRecord(
	value: unknown,
	callbacks: TailerCallbacks,
	enrichment: EventEnrichmentState,
): void {
	if (!value || typeof value !== "object") return;
	const normalized = normalizePiRecord(
		value as {
			type?: string;
			[key: string]: unknown;
		},
	);
	if (normalized.session) callbacks.onSession?.(normalized.session);
	for (const event of normalized.events)
		callbacks.onEvent(enrichEvent(event, enrichment));
}
function sessionFromHello(value: unknown): SessionInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const hello = value as Record<string, unknown>;
	const id = hello.id ?? hello.sessionId ?? hello.session_id;
	return typeof id === "string"
		? {
				id,
				project_name:
					typeof hello.project === "string" ? hello.project : undefined,
				current_goal: typeof hello.goal === "string" ? hello.goal : undefined,
			}
		: undefined;
}

function handleFrame(
	frame: SseFrame,
	callbacks: TailerCallbacks,
	enrichment: EventEnrichmentState,
	onPhase?: (phase: "snapshot" | "delta") => void,
): void {
	let data: unknown;
	try {
		data = JSON.parse(frame.data);
	} catch {
		return;
	}
	if (frame.event === "hello") {
		const session = sessionFromHello(data);
		if (session) callbacks.onSession?.(session);
		return;
	}
	if (frame.event === "snapshot" || frame.event === "delta")
		onPhase?.(frame.event);
	const payload = data as Record<string, unknown>;
	const records = Array.isArray(data)
		? data
		: Array.isArray(payload.events)
			? payload.events
			: Array.isArray(payload.records)
				? payload.records
				: [payload.event ?? data];
	for (const record of records) emitRecord(record, callbacks, enrichment);
}

export type ParseSseOptions = {
	onPhase?: (phase: "snapshot" | "delta") => void;
	sessionFile?: string;
	enrichment?: EventEnrichmentState;
};

export async function parseSseStream(
	body: ReadableStream<Uint8Array>,
	callbacks: TailerCallbacks,
	options: ParseSseOptions = {},
): Promise<void> {
	const enrichment = options.enrichment ?? enrichmentState(options.sessionFile);
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let discarding = false;
	let event = "message";
	let data: string[] = [];
	let dataBytes = 0;
	let poisoned = false;
	const overflow = (message: string) => {
		console.warn(`pi-durable: ${message}`);
		callbacks.onError?.(message);
	};
	const dispatch = () => {
		if (data.length) {
			if (poisoned)
				overflow(`dropping SSE event over ${MAX_EVENT_BYTES} bytes`);
			else
				handleFrame(
					{ event, data: data.join("\n") },
					callbacks,
					enrichment,
					options.onPhase,
				);
		}
		event = "message";
		data = [];
		dataBytes = 0;
		poisoned = false;
	};
	const line = (raw: string) => {
		if (discarding) {
			discarding = false;
			overflow(`dropping SSE line over ${MAX_LINE_BYTES} bytes`);
			return;
		}
		if (!raw) {
			dispatch();
			return;
		}
		if (raw.startsWith("event:")) event = raw.slice(6).trim();
		else if (raw.startsWith("data:")) {
			const piece = raw.slice(5);
			if (dataBytes + Buffer.byteLength(piece) > MAX_EVENT_BYTES) {
				poisoned = true; // dispatch reports the drop once the event ends
				return;
			}
			dataBytes += Buffer.byteLength(piece);
			data.push(piece.trimStart());
		}
	};
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		pending += decoder.decode(next.value, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			line(pending.slice(0, newline).replace(/\r$/, ""));
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
		if (!discarding && pending.length > MAX_LINE_BYTES) {
			discarding = true;
			pending = "";
			overflow(
				`SSE line exceeds ${MAX_LINE_BYTES} bytes; discarding until newline`,
			);
		}
	}
	pending += decoder.decode();
	for (const raw of pending.split(/\r?\n/)) line(raw);
	dispatch();
}

export async function streamDurableSession(
	baseUrl: string,
	sessionId: string,
	callbacks: TailerCallbacks,
	fallback: () => Promise<void>,
	agent: "pi" | "omp" = "pi",
	signal?: AbortSignal,
	options: ParseSseOptions = {},
): Promise<boolean> {
	const base = baseUrl.replace(/\/$/, "");
	const legacy = `${base}/v1/sessions/${encodeURIComponent(sessionId)}`;
	const canonical = `${legacy}/agents/${encodeURIComponent(agent)}?read_only=true`;
	try {
		let response = await fetch(canonical, {
			headers: { Accept: "text/event-stream" },
			signal,
		});
		if (response.status === 400 || response.status === 404)
			response = await fetch(legacy, {
				headers: { Accept: "text/event-stream" },
				signal,
			});
		if (!response.ok || !response.body)
			throw new Error(`Durable SSE returned ${response.status}`);
		await parseSseStream(response.body, callbacks, options);
		return true;
	} catch {
		if (signal?.aborted) return false;
		await fallback();
		return false;
	}
}

export type SuperviseOptions = {
	baseMs?: number;
	maxMs?: number;
	resetAfterMs?: number;
	sleep?: (milliseconds: number) => Promise<void>;
	shouldStop?: () => boolean;
	agent?: "pi" | "omp";
	signal?: AbortSignal;
	onPhase?: (phase: "snapshot" | "delta") => void;
	sessionFile?: string;
};

// Retries forever on clean stream end AND on connect failure (which first runs
// the fallback poll), with doubling backoff capped at maxMs; a stream that
// stayed healthy for resetAfterMs resets the backoff to baseMs.
export async function superviseDurableSession(
	baseUrl: string,
	sessionId: string,
	callbacks: TailerCallbacks,
	fallback: () => Promise<void>,
	options: SuperviseOptions = {},
): Promise<void> {
	const baseMs = options.baseMs ?? 1_000;
	const maxMs = options.maxMs ?? 8_000;
	const resetAfterMs = options.resetAfterMs ?? 60_000;
	const sleep =
		options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
	const shouldStop = options.shouldStop ?? (() => false);
	const enrichment = enrichmentState(options.sessionFile);
	let delayMs = baseMs;
	while (!shouldStop() && !options.signal?.aborted) {
		const startedAt = Date.now();
		const connected = await streamDurableSession(
			baseUrl,
			sessionId,
			callbacks,
			fallback,
			options.agent,
			options.signal,
			{
				onPhase: options.onPhase,
				sessionFile: options.sessionFile,
				enrichment,
			},
		);
		if (shouldStop() || options.signal?.aborted) return;
		if (connected && Date.now() - startedAt >= resetAfterMs) delayMs = baseMs;
		await sleep(delayMs);
		delayMs = Math.min(delayMs * 2, maxMs);
	}
}
