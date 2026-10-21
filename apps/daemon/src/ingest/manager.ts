import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Timer } from "node:timers";
import type { SessionEvent, SessionInfo } from "./events.ts";
import { normalizeClaudeRecord, normalizeCodexRecord } from "./harness.ts";
import { superviseDurableSession } from "./pi-durable.ts";
import { PiTailer } from "./pi-jsonl.ts";

export type Harness = "pi" | "omp" | "codex" | "claude" | "auto";
export type Candidate = { path: string; harness: Harness; modified: number };

export type IngestHost = {
	onEvent(event: SessionEvent): void;
	onSession(session: SessionInfo): void;
	broadcast(message: object): void;
	reset(): void;
	watched(path: string): void;
	hydrate(value: boolean): void;
};

export function sessionDirectories(home: string): Record<Harness, string[]> {
	const omp = join(home, ".omp/agent/sessions");
	const pi = join(home, ".pi/agent/sessions");
	const codex = join(home, ".codex/sessions");
	const claude = join(home, ".claude/projects");
	return {
		omp: [omp],
		pi: [pi],
		codex: [codex],
		claude: [claude],
		auto: [omp, pi, codex, claude],
	};
}

export async function newestSession(
	directories: Record<Harness, string[]>,
	selected: Harness,
): Promise<Candidate | undefined> {
	let newest: Candidate | undefined;
	for (const [kind, paths] of Object.entries(directories) as Array<
		[Harness, string[]]
	>) {
		if (selected !== "auto" && kind !== selected) continue;
		if (kind === "auto") continue;
		for (const directory of paths) {
			try {
				if (!(await stat(directory)).isDirectory()) continue;
			} catch {
				continue; // missing harness directory on a clean HOME
			}
			for await (const path of new Bun.Glob("**/*.jsonl").scan({
				cwd: directory,
				absolute: true,
				onlyFiles: true,
			})) {
				try {
					const info = await stat(path);
					if (!newest || info.mtimeMs > newest.modified)
						newest = { path, harness: kind, modified: info.mtimeMs };
				} catch {
					// session vanished while scanning
				}
			}
		}
	}
	return newest;
}

export class IngestManager {
	#timer: Timer | undefined;
	#pollTimer: Timer | undefined;
	#tailer?: PiTailer;
	#durableAbort?: AbortController;
	#watchedPath = "";
	#stopped = false;

	constructor(
		private readonly host: IngestHost,
		private readonly options: {
			harness: Harness;
			directories: Record<Harness, string[]>;
			durableUrl?: string;
			rescanIdleMs?: number;
			rescanWatchingMs?: number;
			pollMs?: number;
		},
	) {}

	start(): void {
		void this.rescan();
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
		this.#releaseTailer();
	}

	async rescan(): Promise<void> {
		if (this.#stopped) return;
		const target = await newestSession(
			this.options.directories,
			this.options.harness,
		);
		if (target && target.path !== this.#watchedPath) await this.#rotate(target);
		this.#schedule(
			target
				? (this.options.rescanWatchingMs ?? 10_000)
				: (this.options.rescanIdleMs ?? 5_000),
		);
	}

	#schedule(milliseconds: number): void {
		clearInterval(this.#timer);
		this.#timer = setInterval(() => void this.rescan(), milliseconds);
	}

	async #rotate(target: Candidate): Promise<void> {
		this.#releaseTailer();
		this.#watchedPath = target.path;
		this.host.reset();
		this.host.watched(target.path);
		this.host.broadcast({
			type: "session_init",
			session_id: undefined,
			project_name: undefined,
			current_goal: undefined,
			transcript_path: target.path,
			events: [],
		});
		const normalizer =
			target.harness === "codex"
				? normalizeCodexRecord
				: target.harness === "claude"
					? normalizeClaudeRecord
					: undefined;
		const tailer = new PiTailer(
			target.path,
			{
				onEvent: (event) => this.host.onEvent(event),
				onSession: (session) => this.host.onSession(session),
				onError: (message) => this.host.broadcast({ type: "error", message }),
			},
			normalizer,
		);
		this.#tailer = tailer;
		if (
			this.options.durableUrl &&
			(target.harness === "pi" || target.harness === "omp")
		) {
			const sessionId =
				target.path
					.split("/")
					.at(-1)
					?.replace(/\.jsonl$/, "") ?? "";
			const controller = new AbortController();
			this.#durableAbort = controller;
			this.host.hydrate(true);
			void superviseDurableSession(
				this.options.durableUrl,
				sessionId,
				{
					onEvent: (event) => this.host.onEvent(event),
					onSession: (session) => this.host.onSession(session),
					onError: (message) => this.host.broadcast({ type: "error", message }),
				},
				async () => {
					this.host.hydrate(true);
					try {
						await tailer.poll();
					} finally {
						this.host.hydrate(false);
					}
				},
				{
					agent: target.harness,
					sessionFile: target.path,
					signal: controller.signal,
					onPhase: (phase) => this.host.hydrate(phase === "snapshot"),
					shouldStop: () => this.#stopped || this.#tailer !== tailer,
				},
			);
			return;
		}
		this.host.hydrate(true);
		try {
			await tailer.poll();
		} finally {
			this.host.hydrate(false);
		}
		this.#pollTimer = setInterval(
			() => void tailer.poll(),
			this.options.pollMs ?? 500,
		);
	}

	#releaseTailer(): void {
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
		this.#durableAbort?.abort();
		this.#durableAbort = undefined;
		this.#tailer = undefined;
		this.host.hydrate(false);
	}
}
