import { expect, test } from "bun:test";
import { parseChart } from "./InlineChart";

test("inline run charts reject invalid and oversized points", () => {
	expect(parseChart('{"points":[{"step":1,"value":0.2}]}')?.points).toEqual([
		{ step: 1, value: 0.2 },
	]);
	expect(parseChart('{"points":[{"step":"1","value":0.2}]}')).toBeUndefined();
	expect(
		parseChart(
			JSON.stringify({
				points: Array.from({ length: 201 }, (_, i) => ({ step: i, value: i })),
			}),
		),
	).toBeUndefined();
	expect(parseChart("not JSON")).toBeUndefined();
});
