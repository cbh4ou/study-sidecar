export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Manually advanced clock for deterministic tests. */
export class FakeClock implements Clock {
	#now: number;
	#timers = new Map<number, { at: number; fn: () => void }>();
	#next = 1;
	constructor(start = Date.parse("2026-01-01T00:00:00Z")) {
		this.#now = start;
	}
	now(): number {
		return this.#now;
	}
	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.#next++;
		this.#timers.set(id, { at: this.#now + ms, fn });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.#timers.delete(handle as number);
	}
	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.#timers.delete(due[0]);
			this.#now = due[1].at;
			due[1].fn();
		}
		this.#now = target;
	}
}
