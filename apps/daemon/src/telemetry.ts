import { type DaemonContext, type Feature, json } from "./feature.ts";
import type { TelemetryEntry, TurnTelemetry } from "./protocol.ts";
import type { TelemetryRecorder } from "./services.ts";

export const TELEMETRY_MAX = 50;

/** Per-turn timings ring buffer (newest last). Logged, never gated on. */
export class Telemetry implements TelemetryRecorder {
	#entries: TelemetryEntry[] = [];
	#audio = new Map<string, number>();
	audio(turnId: string, ms: number): TelemetryEntry | undefined {
		const entry = this.#entries.find((entry) => entry.turnId === turnId);
		if (entry) {
			entry.tts_first_audio_ms = ms;
			return { ...entry };
		}
		this.#audio.set(turnId, ms);
		if (this.#audio.size > this.max)
			this.#audio.delete(this.#audio.keys().next().value ?? "");
	}
	constructor(
		private readonly max = TELEMETRY_MAX,
		private readonly now: () => number = Date.now,
	) {}

	record(turnId: string, telemetry: TurnTelemetry): void {
		const audio = this.#audio.get(turnId);
		if (audio !== undefined) {
			telemetry.tts_first_audio_ms = audio;
			this.#audio.delete(turnId);
		}
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
		onClientMessage(message) {
			if (message.type !== "turn_telemetry") return false;
			const entry = telemetry.audio(message.turnId, message.tts_first_audio_ms);
			if (entry)
				context.broadcast({
					type: "turn_settled",
					turnId: message.turnId,
					telemetry: entry,
				});
			return true;
		},
		route(request, url, cors) {
			if (url.pathname !== "/api/telemetry") return undefined;
			if (request.method !== "GET")
				return json({ error: "method not allowed" }, cors, 405);
			return json({ turns: telemetry.recent() }, cors);
		},
	};
}
