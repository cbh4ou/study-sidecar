import type { Timer } from "node:timers";
import type { SessionEvent } from "../ingest/events.ts";
import type { TutorMode } from "../modes/modes.ts";

/** Cooldown gatekeeper: has enough time passed since the tutor last spoke? */
export function cooldownPassed(
	mode: TutorMode,
	lastSpoke: number,
	now = Date.now(),
): boolean {
	return now - lastSpoke >= mode.chattiness.cooldown_sec * 1000;
}

export type DeadAirOptions = {
	seconds: number;
	events: () => SessionEvent[];
	mode: () => TutorMode;
	lastSpoke: () => number;
	onDeadAir: (command: string) => void;
};

/**
 * Dead-air timer: fire when a bash call stays quiet for `seconds` while a
 * recent write/edit exists and the mode cooldown allows speaking.
 */
export class DeadAirWatch {
	#timer?: Timer;
	constructor(private readonly options: DeadAirOptions) {}

	touch(command: string): void {
		this.cancel();
		const configuredMs = this.options.mode().wake_triggers.on_dead_air_ms;
		const milliseconds =
			configuredMs > 0 ? configuredMs : this.options.seconds * 1000;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (
				cooldownPassed(this.options.mode(), this.options.lastSpoke()) &&
				this.options
					.events()
					.slice(-10)
					.some(
						(event) =>
							event.event_type === "tool_call" &&
							["write", "edit"].includes(event.tool_name?.toLowerCase() ?? ""),
					)
			)
				this.options.onDeadAir(command);
		}, milliseconds);
	}

	cancel(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}
