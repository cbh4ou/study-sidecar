import { describe, expect, test } from "bun:test";
import { hudReducer, initialHudState } from "./hud-state";

describe("mentor HUD state", () => {
	test("moves from compact to ambient for an insight and returns after timeout", () => {
		const ambient = hudReducer(initialHudState, {
			type: "ambient",
			insight: "Check the error.",
		});
		expect(ambient).toEqual({
			mode: "AMBIENT_PILL",
			insight: "Check the error.",
		});
		expect(hudReducer(ambient, { type: "timeout" })).toEqual(initialHudState);
	});

	test("expands for explicit, dead-air, and tutor triggers", () => {
		expect(hudReducer(initialHudState, { type: "expand" }).mode).toBe(
			"EXPANDED_MENTOR",
		);
		expect(hudReducer(initialHudState, { type: "dead_air" }).mode).toBe(
			"EXPANDED_MENTOR",
		);
		expect(hudReducer(initialHudState, { type: "tutor_answer" }).mode).toBe(
			"EXPANDED_MENTOR",
		);
	});
});
