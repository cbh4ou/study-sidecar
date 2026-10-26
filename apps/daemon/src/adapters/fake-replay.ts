import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DaemonContext, Feature } from "../feature.ts";
import type { SessionEvent } from "../ingest/events.ts";

export const FAKE_SESSION_PATH = fileURLToPath(
	new URL("../fixtures/session.jsonl", import.meta.url),
);

const SessionEventSchema = z.object({
	timestamp: z.string(),
	event_type: z.enum([
		"user_task",
		"agent_thought",
		"agent_message",
		"tool_call",
		"tool_result",
	]),
	headline: z.string(),
	details: z.string(),
	id: z.string().optional(),
	parent_id: z.string().optional(),
	session_file: z.string().optional(),
	diff: z.string().optional(),
	bash_tail: z.string().optional(),
	signals: z.array(z.string()).optional(),
	dead_air: z.boolean().optional(),
	tool_name: z.string().optional(),
	file_path: z.string().optional(),
	is_error: z.boolean().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Parse a SessionEvent JSONL fixture; throws with the line number on bad input. */
export function parseSessionFixture(text: string): SessionEvent[] {
	const events: SessionEvent[] = [];
	text.split("\n").forEach((line, index) => {
		if (!line.trim()) return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			throw new Error(`session fixture line ${index + 1}: invalid JSON`);
		}
		const parsed = SessionEventSchema.safeParse(raw);
		if (!parsed.success)
			throw new Error(
				`session fixture line ${index + 1}: ${parsed.error.message}`,
			);
		events.push(parsed.data as SessionEvent);
	});
	return events;
}

export async function loadSessionFixture(
	path = FAKE_SESSION_PATH,
): Promise<SessionEvent[]> {
	return parseSessionFixture(await readFile(path, "utf8"));
}

export type FakeReplayOptions = {
	path?: string;
	intervalMs?: number;
};

/** Fake mode only: replays fixtures/session.jsonl at 1 event/sec, once. */
export function createFakeReplayFeature(
	context: DaemonContext,
	options: FakeReplayOptions = {},
): Feature {
	let timer: unknown;
	let stopped = false;
	const interval = options.intervalMs ?? 1_000;
	return {
		name: "fake-replay",
		async start() {
			if (!context.fake) return;
			stopped = false;
			const events = await loadSessionFixture(options.path);
			let index = 0;
			const tick = () => {
				timer = undefined;
				if (stopped) return;
				const event = events[index++];
				if (!event) return;
				context.ingestEvent({
					...event,
					timestamp: new Date(context.ports.clock.now()).toISOString(),
				});
				if (index < events.length)
					timer = context.ports.clock.setTimeout(tick, interval);
			};
			timer = context.ports.clock.setTimeout(tick, interval);
		},
		stop() {
			stopped = true;
			if (timer !== undefined) context.ports.clock.clearTimeout(timer);
			timer = undefined;
		},
	};
}
