import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { generateToken } from "../apps/daemon/src/auth.ts";

export type ChildSpec = {
	name: string;
	command: string[];
	env?: Record<string, string | undefined>;
	fallbackUrl?: string;
};

type ChildState = {
	pid: number;
	status: "alive" | "dead";
	restarts: number;
};

type SidecarState = {
	pid: number;
	children: Record<string, ChildState>;
};

type SupervisorOptions = {
	root: string;
	runDir?: string;
	children: ChildSpec[];
	token?: string;
	restartBaseMs?: number;
	maxRestarts?: number;
	graceMs?: number;
};

type ChildProcess = Bun.Subprocess;

type ManagedChild = {
	spec: ChildSpec;
	process: ChildProcess;
	startedAt: number;
	restarts: number;
};

const DEFAULT_RUN_DIR = join(dirname(dirname(import.meta.path)), ".run");
const sleep = (milliseconds: number) => Bun.sleep(milliseconds);

let writeSequence = 0;
export async function writeJson(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// Unique temp per call: concurrent persists sharing one temp name raced
	// their renames (ENOENT crash of the supervisor, orphaning children).
	const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
	await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
	await rename(temporary, path);
}

async function readJson(path: string): Promise<SidecarState | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as SidecarState;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function portOpen(port: number, timeoutMs = 2_000): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = createConnection({ host: "127.0.0.1", port });
	const finish = (open: boolean) => {
		socket.destroy();
		resolve(open);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	setTimeout(() => finish(false), timeoutMs).unref();
	return await promise;
}

function terminate(child: ManagedChild, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(-child.process.pid, signal);
	} catch {
		try {
			child.process.kill(signal);
		} catch {
			// The child already exited.
		}
	}
}

export class Supervisor {
	readonly runDir: string;
	readonly statePath: string;
	readonly tokenPath: string;
	readonly restartCounts = new Map<string, number>();
	private readonly children = new Map<string, ManagedChild>();
	private readonly specs = new Map<string, ChildSpec>();
	private readonly restartBaseMs: number;
	private readonly maxRestarts: number;
	private readonly graceMs: number;
	private readonly token?: string;
	private stopping = false;
	private readonly done = Promise.withResolvers<number>();

	constructor(private readonly options: SupervisorOptions) {
		this.runDir = options.runDir ?? DEFAULT_RUN_DIR;
		this.statePath = join(this.runDir, "sidecar.json");
		this.pidPath = join(this.runDir, "sidecar.pid");
		this.tokenPath = join(this.runDir, "token");
		this.restartBaseMs = options.restartBaseMs ?? 1_000;
		this.maxRestarts = options.maxRestarts ?? 5;
		this.graceMs = options.graceMs ?? 5_000;
		this.token = options.token;
		for (const spec of options.children) this.specs.set(spec.name, spec);
	}

	async start(): Promise<void> {
		await mkdir(this.runDir, { recursive: true });
		await Bun.write(this.pidPath, `${process.pid}\n`);
		if (this.token)
			await writeFile(this.tokenPath, this.token, { mode: 0o600 });
		for (const spec of this.specs.values()) this.launch(spec);
	}

	async wait(): Promise<number> {
		return await this.done.promise;
	}

	private launch(
		spec: ChildSpec,
		restarts = this.restartCounts.get(spec.name) ?? 0,
	): void {
		const env = { ...process.env, ...spec.env };
		if (spec.name === "voice") delete env.SIDECAR_TOKEN;
		if (spec.name === "desktop") delete env.SIDECAR_VOICE_TOKEN;
		const child = Bun.spawn(spec.command, {
			cwd: this.options.root,
			env,
			stdout: "inherit",
			stderr: "inherit",
			detached: false,
		});
		const managed: ManagedChild = {
			spec,
			process: child,
			startedAt: Date.now(),
			restarts,
		};
		this.children.set(spec.name, managed);
		this.restartCounts.set(spec.name, restarts);
		void this.persist();
		void child.exited.then(() => this.exited(managed));
	}

	private async exited(child: ManagedChild): Promise<void> {
		if (this.children.get(child.spec.name) === child)
			this.children.delete(child.spec.name);
		await this.persist();
		if (this.stopping) return;

		if (child.spec.name === "desktop" && Date.now() - child.startedAt < 2_000) {
			console.error(
				"desktop dependencies unavailable; opening the daemon in the browser instead",
			);
			Bun.spawn(
				["xdg-open", child.spec.fallbackUrl ?? "http://127.0.0.1:4321"],
				{
					cwd: this.options.root,
					stdout: "inherit",
					stderr: "inherit",
				},
			);
			return;
		}

		const restarts =
			Date.now() - child.startedAt >= 60_000 ? 0 : child.restarts;
		if (restarts >= this.maxRestarts) {
			console.error(
				`${child.spec.name} exceeded ${this.maxRestarts} restart attempts; shutting down sidecar`,
			);
			await this.shutdown(1);
			return;
		}
		const next = restarts + 1;
		this.restartCounts.set(child.spec.name, next);
		await this.persist();
		await sleep(Math.min(this.restartBaseMs * 2 ** (next - 1), 8_000));
		if (!this.stopping) this.launch(child.spec, next);
	}

	private persistChain: Promise<void> = Promise.resolve();
	private async persist(): Promise<void> {
		if (this.stopping) return;
		const children: Record<string, ChildState> = {};
		for (const spec of this.specs.values()) {
			const child = this.children.get(spec.name);
			children[spec.name] = {
				pid: child?.process.pid ?? 0,
				status: child ? "alive" : "dead",
				restarts: this.restartCounts.get(spec.name) ?? 0,
			};
		}
		// Serialized: concurrent launches/exits each get their own write.
		const run = this.persistChain.then(() =>
			writeJson(this.statePath, { pid: process.pid, children }),
		);
		this.persistChain = run.catch(() => undefined);
		return run;
	}

	async shutdown(code: number): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		// A queued persist must not resurrect state files after removal.
		await this.persistChain;
		for (const child of this.children.values()) terminate(child, "SIGTERM");
		const exiting = Promise.all(
			[...this.children.values()].map((child) => child.process.exited),
		);
		await Promise.race([exiting, sleep(this.graceMs)]);
		for (const child of this.children.values()) terminate(child, "SIGKILL");
		await Promise.allSettled(
			[...this.children.values()].map((child) => child.process.exited),
		);
		await Promise.all([
			rm(this.pidPath, { force: true }),
			rm(this.statePath, { force: true }),
			rm(this.tokenPath, { force: true }),
		]);
		this.done.resolve(code);
	}
}

export async function status(runDir = DEFAULT_RUN_DIR): Promise<string> {
	const state = await readJson(join(runDir, "sidecar.json"));
	if (!state) return "sidecar: stopped";
	const rows = Object.entries(state.children).map(([name, child]) => {
		const stateName =
			child.status === "alive" && alive(child.pid) ? "alive" : "dead";
		return `${name}: ${stateName} (restarts: ${child.restarts})`;
	});
	const tokenRow = (await Bun.file(join(runDir, "token")).exists())
		? ["token: <redacted>"]
		: [];
	return [
		`sidecar: ${alive(state.pid) ? "alive" : "dead"}`,
		...rows,
		...tokenRow,
	].join("\n");
}

export async function down(runDir = DEFAULT_RUN_DIR): Promise<void> {
	const pid = Number(
		(
			await readFile(join(runDir, "sidecar.pid"), "utf8").catch(() => "")
		).trim(),
	);
	if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
		process.kill(pid, "SIGTERM");
		for (let waited = 0; waited < 10_000 && alive(pid); waited += 100) {
			await sleep(100);
		}
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	for (const path of [
		join(runDir, "sidecar.pid"),
		join(runDir, "sidecar.json"),
		join(runDir, "token"),
	]) {
		await rm(path, { force: true });
	}
}

function usage(): string {
	return [
		"Usage: bun run sidecar <up|down|status|mcp> [options]",
		"  up [--fake] [--with-voice] [--with-desktop] [--harness auto] [--port 4321] [--token <token>] [--voice-token <token>]",
		"  mcp    stdio MCP server (tutor_ask, tutor_note) for coding agents",
	].join("\n");
}

/** Sidecar home used by `up --fake`: never the real ~/.study-sidecar. */
export const FAKE_HOME = join(DEFAULT_RUN_DIR, "fake-home");

/** Environment every child gets in fake mode. */
export function fakeEnv(home = FAKE_HOME): Record<string, string> {
	return { SIDECAR_FAKE: "1", SIDECAR_HOME: home };
}

function option(args: string[], name: string, fallback: string): string {
	const index = args.indexOf(name);
	return index < 0 ? fallback : (args[index + 1] ?? fallback);
}

export function launchChildren(
	harness: string,
	port: number,
	token: string,
	voiceToken: string,
	withVoice: boolean,
	withDesktop: boolean,
	fake?: { home: string },
): ChildSpec[] {
	const children: ChildSpec[] = [
		{
			name: "daemon",
			// Credentials travel by environment, never argv (visible in /proc).
			command: [
				"bun",
				"run",
				"--cwd",
				"apps/daemon",
				"src/index.ts",
				"--harness",
				harness,
				"--port",
				String(port),
				...(fake ? ["--fake"] : []),
			],
			env: {
				SIDECAR_TOKEN: token,
				SIDECAR_VOICE_TOKEN: voiceToken,
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
		},
	];
	if (withVoice) {
		children.push({
			name: "voice",
			command: [
				"uv",
				"run",
				"--project",
				"workers/voice-local",
				"python",
				"workers/voice-local/server.py",
				"--ws",
			],
			env: {
				PYTHONDONTWRITEBYTECODE: "1",
				SIDECAR_VOICE_TOKEN: voiceToken,
			},
		});
	}
	if (withDesktop) {
		children.push({
			name: "desktop",
			command: ["bun", "run", "--cwd", "apps/desktop", "dev"],
			env: { SIDECAR_TOKEN: token },
			fallbackUrl: `http://127.0.0.1:${port}`,
		});
	}
	if (fake)
		for (const child of children)
			child.env = { ...child.env, ...fakeEnv(fake.home) };
	return children;
}

async function main(): Promise<void> {
	const [command, ...args] = Bun.argv.slice(2);
	if (command === "--help" || command === "-h" || !command) {
		console.log(usage());
		return;
	}
	if (command === "status") {
		console.log(await status());
		return;
	}
	if (command === "down") {
		await down();
		return;
	}
	if (command === "mcp") {
		// In-process stdio server: stdout belongs to the MCP transport.
		const { main: mcpMain } = await import("../apps/daemon/src/mcp/server.ts");
		await mcpMain();
		return;
	}
	if (command !== "up") throw new Error(usage());

	const harness = option(args, "--harness", "auto");
	const port = Number(option(args, "--port", "4321"));
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("--port must be a valid TCP port");
	}
	if (await portOpen(port)) {
		throw new Error(
			`daemon port ${port} is already bound. Run \`bun run sidecar down\` and retry; if it persists, an orphan is holding the port: pkill -f "apps/daemon/src/index.ts.*--port ${port}"`,
		);
	}
	const token =
		option(args, "--token", "") || process.env.SIDECAR_TOKEN || generateToken();
	const voiceToken =
		option(args, "--voice-token", "") ||
		process.env.SIDECAR_VOICE_TOKEN ||
		generateToken();
	const root = dirname(dirname(import.meta.path));
	const fake = args.includes("--fake");
	if (fake) await mkdir(FAKE_HOME, { recursive: true, mode: 0o700 });
	const children = launchChildren(
		harness,
		port,
		token,
		voiceToken,
		args.includes("--with-voice"),
		args.includes("--with-desktop"),
		fake ? { home: FAKE_HOME } : undefined,
	);

	const supervisor = new Supervisor({ root, children, token });
	const stop = () => void supervisor.shutdown(0);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await supervisor.start();
		console.log(
			`sidecar daemon: http://127.0.0.1:${port} (token in .run/token)${fake ? `, fake mode, home ${FAKE_HOME}` : ""}`,
		);
		const code = await supervisor.wait();
		process.exitCode = code;
	} catch (error) {
		// Never leave children orphaned by a supervisor crash.
		console.error(`supervisor failed: ${String(error)}`);
		await supervisor.shutdown(1);
		throw error;
	}
}

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
