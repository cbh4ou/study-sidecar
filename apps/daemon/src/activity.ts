import type { ActivityJob } from "./protocol.ts";

export type ActivityHandle = {
	readonly id: string;
	readonly signal: AbortSignal;
	update(patch: Partial<Pick<ActivityJob, "label" | "status">>): void;
	finish(status?: "done" | "error"): void;
};

/**
 * Background job registry behind the Activity dock: every long-running job
 * (deep turn, research, extraction, recap) registers here, gets an abort
 * signal, and broadcasts state changes through `onChange`.
 */
export class ActivityRegistry {
	#jobs = new Map<
		string,
		ActivityJob & { controller: AbortController; finishedAt?: number }
	>();
	#next = 1;
	constructor(
		private readonly onChange: (jobs: ActivityJob[]) => void = () => undefined,
		private readonly keepFinished = 8,
	) {}

	start(
		kind: ActivityJob["kind"],
		label: string,
		status: ActivityJob["status"] = "running",
	): ActivityHandle {
		const id = `${kind}_${this.#next++}`;
		const controller = new AbortController();
		this.#jobs.set(id, { id, kind, label, status, controller });
		this.#emit();
		return {
			id,
			signal: controller.signal,
			update: (patch) => {
				const job = this.#jobs.get(id);
				if (!job) return;
				Object.assign(job, patch);
				this.#emit();
			},
			finish: (final = "done") => {
				const job = this.#jobs.get(id);
				if (!job) return;
				job.status =
					controller.signal.aborted && final === "done" ? "error" : final;
				job.finishedAt = Date.now();
				this.#prune();
				this.#emit();
			},
		};
	}

	abort(id: string): boolean {
		const job = this.#jobs.get(id);
		if (!job || job.status === "done" || job.status === "error") return false;
		job.controller.abort();
		job.status = "error";
		job.label = `${job.label} (stopped)`;
		job.finishedAt = Date.now();
		this.#emit();
		return true;
	}

	list(): ActivityJob[] {
		return [...this.#jobs.values()].map(({ id, kind, label, status }) => ({
			id,
			kind,
			label,
			status,
		}));
	}

	#prune(): void {
		const finished = [...this.#jobs.values()]
			.filter((job) => job.finishedAt !== undefined)
			.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
		while (finished.length > this.keepFinished) {
			const old = finished.shift();
			if (old) this.#jobs.delete(old.id);
		}
	}

	#emit(): void {
		this.onChange(this.list());
	}
}
