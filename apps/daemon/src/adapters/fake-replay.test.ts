import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "../feature.ts";
import type { SessionEvent } from "../ingest/events.ts";
import { FakeClock } from "../ports/clock.ts";
import {
	createFakeReplayFeature,
	loadSessionFixture,
	parseSessionFixture,
} from "./fake-replay.ts";

function context(fake: boolean, clock: FakeClock, sink: SessionEvent[]) {
	return {
		fake,
		ports: { clock },
		ingestEvent: (event: SessionEvent) => sink.push(event),
	} as unknown as DaemonContext;
}

describe("fake replay", () => {
	test("fixture parses and covers the spec event shapes", async () => {
		const events = await loadSessionFixture();
		expect(events.length).toBeGreaterThanOrEqual(18);
		const types = new Set(events.map((event) => event.event_type));
		for (const type of [
			"user_task",
			"tool_call",
			"tool_result",
			"agent_message",
		])
			expect(types.has(type as SessionEvent["event_type"])).toBe(true);
		expect(
			events.some((event) => event.tool_name === "Edit" && event.diff),
		).toBe(true);
		expect(events.some((event) => event.bash_tail)).toBe(true);
		expect(
			events.some(
				(event) =>
					event.is_error && /acknowledgement.*timed out/.test(event.details),
			),
		).toBe(true);
		expect(
			events.every((event) => event.session_file === "fake/session.jsonl"),
		).toBe(true);
	});

	test("rejects malformed lines with a line number", () => {
		expect(() => parseSessionFixture('{"timestamp":"t"}\n')).toThrow("line 1");
		expect(() => parseSessionFixture("\nnot json")).toThrow("line 2");
	});

	test("feeds one event per interval and stop cancels", async () => {
		const clock = new FakeClock();
		const sink: SessionEvent[] = [];
		const feature = createFakeReplayFeature(context(true, clock, sink));
		await feature.start?.();
		expect(sink).toHaveLength(0);
		clock.advance(1_000);
		expect(sink).toHaveLength(1);
		expect(sink[0]?.event_type).toBe("user_task");
		clock.advance(2_000);
		expect(sink).toHaveLength(3);
		await feature.stop?.();
		clock.advance(60_000);
		expect(sink).toHaveLength(3);
	});

	test("does nothing outside fake mode", async () => {
		const clock = new FakeClock();
		const sink: SessionEvent[] = [];
		const feature = createFakeReplayFeature(context(false, clock, sink));
		await feature.start?.();
		clock.advance(60_000);
		expect(sink).toHaveLength(0);
	});
});
