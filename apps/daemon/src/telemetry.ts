import { type DaemonContext, type Feature, json } from "./feature.ts";
import type { TelemetryEntry, TurnTelemetry } from "./protocol.ts";
import type { TelemetryRecorder } from "./services.ts";

export const TELEMETRY_MAX = 50;

/** Per-turn timings ring buffer (newest last). Logged, never gated on. */
export class Telemetry implements TelemetryRecorder {
	#entries: TelemetryEntry[] = [];
	constructor(
		private readonly max = TELEMETRY_MAX,
		private readonly now: () => number = Date.now,
	) {}

	record(turnId: string, telemetry: TurnTelemetry): void {
		const existing = this.#entries.findIndex(
			(entry) => entry.turnId === turnId,
		);
		if (existing >= 0) this.#entries.splice(existing, 1);
		this.#entries.push({ ...telemetry, turnId, at: this.now() });
		if (this.#entries.length > this.max)
			this.#entries.splice(0, this.#entries.length - this.max);
	}

	recent(limit = this.max): TelemetryEntry[] {
		if (limit <= 0) return [];
		return this.#entries.slice(-limit).map((entry) => ({ ...entry }));
	}
}

/** Registers `services.telemetry` and serves `GET /api/telemetry`. */
export function createTelemetryFeature(context: DaemonContext): Feature {
	const telemetry = new Telemetry(TELEMETRY_MAX, () =>
		context.ports.clock.now(),
	);
	context.services.telemetry = telemetry;
	return {
		name: "telemetry",
		route(request, url, cors) {
			if (url.pathname !== "/api/telemetry") return undefined;
			if (request.method !== "GET")
				return json({ error: "method not allowed" }, cors, 405);
			return json({ turns: telemetry.recent() }, cors);
		},
	};
}
