import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "./feature.ts";
import { FakeClock } from "./ports/clock.ts";
import type { TelemetryEntry } from "./protocol.ts";
import type { Services } from "./services.ts";
import { createTelemetryFeature, Telemetry } from "./telemetry.ts";

describe("Telemetry", () => {
	test("ring buffer keeps the newest 50, newest last", () => {
		let now = 0;
		const telemetry = new Telemetry(50, () => ++now);
		for (let i = 0; i < 60; i++)
			telemetry.record(`t${i}`, { packet_tokens: i });
		const recent = telemetry.recent();
		expect(recent).toHaveLength(50);
		expect(recent[0]?.turnId).toBe("t10");
		expect(recent.at(-1)?.turnId).toBe("t59");
		expect(recent.at(-1)?.at).toBe(60);
		expect(telemetry.recent(2).map((entry) => entry.turnId)).toEqual([
			"t58",
			"t59",
		]);
		expect(telemetry.recent(0)).toEqual([]);
	});

	test("re-recording a turn replaces it and moves it to the end", () => {
		const telemetry = new Telemetry();
		telemetry.record("a", { packet_tokens: 1 });
		telemetry.record("b", { packet_tokens: 2 });
		telemetry.record("a", { packet_tokens: 3, decide_ms: 4 });
		expect(telemetry.recent().map((entry) => entry.turnId)).toEqual(["b", "a"]);
		expect(telemetry.recent().at(-1)?.decide_ms).toBe(4);
	});
});

describe("telemetry feature", () => {
	test("registers the service and serves GET /api/telemetry", async () => {
		const services: Services = {};
		const clock = new FakeClock(1_000);
		const feature = createTelemetryFeature({
			services,
			ports: { clock },
		} as unknown as DaemonContext);
		services.telemetry?.record("turn-1", {
			packet_tokens: 900,
			decide_adapter: "rules",
		});
		const url = new URL("http://127.0.0.1/api/telemetry");
		const response = await feature.route?.(new Request(url), url, {
			"x-cors": "1",
		});
		expect(response?.status).toBe(200);
		expect(response?.headers.get("x-cors")).toBe("1");
		const body = (await response?.json()) as { turns: TelemetryEntry[] };
		expect(body.turns).toEqual([
			{
				turnId: "turn-1",
				at: 1_000,
				packet_tokens: 900,
				decide_adapter: "rules",
			},
		]);
		const other = new URL("http://127.0.0.1/api/other");
		expect(
			await feature.route?.(new Request(other), other, {}),
		).toBeUndefined();
	});
});
