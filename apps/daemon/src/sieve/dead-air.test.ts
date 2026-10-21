import { describe, expect, test, vi } from "bun:test";
import type { SessionEvent } from "../ingest/events.ts";
import { cooldownPassed, DeadAirWatch } from "./dead-air.ts";

const mode = {
	name: "test",
	title: "Test",
	description: "",
	chattiness: { cooldown_sec: 30, max_proactive_per_10m: 3 },
	wake_triggers: { on_tools: [], on_dead_air_ms: 0 },
	voice: {},
	prompt: "",
	source: "test",
};
const editEvent = (): SessionEvent => ({
	timestamp: new Date().toISOString(),
	event_type: "tool_call",
	headline: "Edit",
	details: "d",
	tool_name: "edit",
});
const watch = (fired: string[], events: SessionEvent[], activeMode = mode) =>
	new DeadAirWatch({
		seconds: 1,
		events: () => events,
		mode: () => activeMode,
		lastSpoke: () => 0,
		onDeadAir: (command) => fired.push(command),
	});

describe("dead-air watch", () => {
	test("cooldownPassed respects the mode chattiness window", () => {
		expect(cooldownPassed(mode, 1_000, 31_000)).toBe(true);
		expect(cooldownPassed(mode, 1_000, 30_999)).toBe(false);
	});

	test("fires after the quiet window only when a recent write/edit exists", () => {
		vi.useFakeTimers();
		const fired: string[] = [];
		const empty = watch(fired, []);
		empty.touch("pytest -q");
		vi.advanceTimersByTime(1_000);
		expect(fired).toEqual([]);
		const withEdit = watch(fired, [editEvent()]);
		withEdit.touch("pytest -q");
		vi.advanceTimersByTime(1_000);
		expect(fired).toEqual(["pytest -q"]);
		vi.useRealTimers();
	});

	test("uses the mode dead-air override when configured", () => {
		vi.useFakeTimers();
		const fired: string[] = [];
		const subject = watch(fired, [editEvent()], {
			...mode,
			wake_triggers: { ...mode.wake_triggers, on_dead_air_ms: 250 },
		});
		subject.touch("edit a.ts");
		vi.advanceTimersByTime(249);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual(["edit a.ts"]);
		vi.useRealTimers();
	});

	test("cancel prevents a scheduled fire", () => {
		vi.useFakeTimers();
		const fired: string[] = [];
		const subject = watch(fired, [editEvent()]);
		subject.touch("bun test");
		subject.cancel();
		vi.advanceTimersByTime(1_000);
		expect(fired).toEqual([]);
		vi.useRealTimers();
	});
});
