import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	down,
	FAKE_HOME,
	fakeEnv,
	launchChildren,
	Supervisor,
	status,
	writeJson,
} from "./sidecar";

const root = dirname(import.meta.dir);
const bunPath = process.execPath;
const directories: string[] = [];

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "sidecar-test-"));
	directories.push(directory);
	return directory;
}

// Process readiness and signal delivery are OS integration behavior; fake
// timers cannot drive them, so each wait polls for the real filesystem signal.
async function waitFor(path: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await Bun.file(path).exists()) return;
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${path}`);
}

// The child announces readiness only after its SIGTERM handler exists; a
// signal delivered earlier kills it with the default action and no marker.
function dummy(marker: string) {
	return `process.on("SIGTERM", () => Bun.write(${JSON.stringify(marker)}, "terminated").then(() => process.exit(0))); Bun.write(${JSON.stringify(`${marker}.ready`)}, "ready"); setInterval(() => {}, 1_000);`;
}

async function startRunner(runDir: string, children: string[]) {
	const script = join(runDir, "runner.ts");
	await Bun.write(
		script,
		[
			`import { Supervisor } from ${JSON.stringify(join(import.meta.dir, "sidecar.ts"))};`,
			`const supervisor = new Supervisor({ root: ${JSON.stringify(root)}, runDir: ${JSON.stringify(runDir)}, graceMs: 100, children: [${children.join(",")}] });`,
			'process.once("SIGTERM", () => void supervisor.shutdown(0));',
			"await supervisor.start();",
			"await supervisor.wait();",
		].join("\n"),
	);
	const spawned = Bun.spawn([bunPath, script], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await waitFor(join(runDir, "sidecar.json"));
	return spawned;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

test("SIGTERM stops every supervised child", async () => {
	const runDir = await temporaryDirectory();
	const first = join(runDir, "first");
	const second = join(runDir, "second");
	const runner = await startRunner(runDir, [
		`{ name: "one", command: [${JSON.stringify(bunPath)}, "-e", ${JSON.stringify(dummy(first))}] }`,
		`{ name: "two", command: [${JSON.stringify(bunPath)}, "-e", ${JSON.stringify(dummy(second))}] }`,
	]);
	await waitFor(`${first}.ready`);
	await waitFor(`${second}.ready`);

	process.kill(runner.pid, "SIGTERM");
	await runner.exited;

	expect(await readFile(first, "utf8")).toBe("terminated");
	expect(await readFile(second, "utf8")).toBe("terminated");
});

test("crashing child reaches the capped restart limit", async () => {
	const runDir = await temporaryDirectory();
	const supervisor = new Supervisor({
		root,
		runDir,
		restartBaseMs: 10,
		maxRestarts: 2,
		children: [{ name: "crash", command: [bunPath, "-e", "process.exit(1)"] }],
	});

	await supervisor.start();

	expect(await supervisor.wait()).toBe(1);
	expect(supervisor.restartCounts.get("crash")).toBe(2);
});

test("status reports and down stops a running daemon", async () => {
	const runDir = await temporaryDirectory();
	const marker = join(runDir, "daemon");
	const runner = await startRunner(runDir, [
		`{ name: "daemon", command: [${JSON.stringify(bunPath)}, "-e", ${JSON.stringify(dummy(marker))}] }`,
	]);
	await waitFor(`${marker}.ready`);

	expect(await status(runDir)).toContain("daemon: alive (restarts: 0)");
	await down(runDir);
	await runner.exited;

	expect(await status(runDir)).toBe("sidecar: stopped");
	expect(await readFile(marker, "utf8")).toBe("terminated");
});

test("token is stored 0600, redacted in status, and removed on shutdown", async () => {
	const runDir = await temporaryDirectory();
	const supervisor = new Supervisor({
		root,
		runDir,
		token: "sekrit-token",
		children: [
			{
				name: "idle",
				command: [bunPath, "-e", "setInterval(() => {}, 1_000)"],
			},
		],
	});
	await supervisor.start();
	const tokenPath = join(runDir, "token");

	expect(await readFile(tokenPath, "utf8")).toBe("sekrit-token");
	expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
	expect(await status(runDir)).toContain("token: <redacted>");
	expect(await status(runDir)).not.toContain("sekrit-token");

	await supervisor.shutdown(0);
	expect(await Bun.file(tokenPath).exists()).toBe(false);
	expect(await status(runDir)).toBe("sidecar: stopped");
});

test("keeps daemon and voice credentials in separate child environments", () => {
	const children = launchChildren(
		"auto",
		4321,
		"daemon-token",
		"voice-token",
		true,
		true,
	);
	const daemon = children.find(({ name }) => name === "daemon");
	const voice = children.find(({ name }) => name === "voice");
	const desktop = children.find(({ name }) => name === "desktop");

	expect(daemon?.command.join(" ")).not.toContain("daemon-token");
	expect(daemon?.command.join(" ")).not.toContain("voice-token");
	expect(daemon?.env).toEqual({
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		SIDECAR_TOKEN: "daemon-token",
		SIDECAR_VOICE_TOKEN: "voice-token",
	});
	expect(voice?.env).toEqual({
		PYTHONDONTWRITEBYTECODE: "1",
		SIDECAR_VOICE_TOKEN: "voice-token",
	});
	expect(desktop?.env).toEqual({ SIDECAR_TOKEN: "daemon-token" });
});

test("voice children do not inherit the daemon token", async () => {
	const runDir = await temporaryDirectory();
	const marker = join(runDir, "voice-env.json");
	const previous = process.env.SIDECAR_TOKEN;
	process.env.SIDECAR_TOKEN = "daemon-token";
	try {
		const supervisor = new Supervisor({
			root,
			runDir,
			maxRestarts: 0,
			children: [
				{
					name: "voice",
					command: [
						bunPath,
						"-e",
						`Bun.write(${JSON.stringify(marker)}, JSON.stringify({ daemon: Boolean(process.env.SIDECAR_TOKEN), voice: process.env.SIDECAR_VOICE_TOKEN })).then(() => process.exit(0));`,
					],
					env: { SIDECAR_VOICE_TOKEN: "voice-token" },
				},
			],
		});
		await supervisor.start();
		await supervisor.wait();
		expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
			daemon: false,
			voice: "voice-token",
		});
	} finally {
		if (previous === undefined) delete process.env.SIDECAR_TOKEN;
		else process.env.SIDECAR_TOKEN = previous;
	}
});

test("concurrent writeJson calls never race their renames", async () => {
	const runDir = await mkdtemp("/tmp/sidecar-persist-");
	const path = join(runDir, "sidecar.json");
	await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			writeJson(path, { pid: process.pid, children: { [index]: {} } }),
		),
	);
	const files = await readdir(runDir);
	expect(files).toEqual(["sidecar.json"]);
	expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
	await rm(runDir, { recursive: true, force: true });
});

test("up --fake passes --fake and an isolated SIDECAR_HOME to every child", () => {
	const children = launchChildren("auto", 4321, "d", "v", true, true, {
		home: "/tmp/fake-home",
	});
	const daemon = children.find(({ name }) => name === "daemon");
	expect(daemon?.command).toContain("--fake");
	for (const child of children) {
		expect(child.env?.SIDECAR_FAKE).toBe("1");
		expect(child.env?.SIDECAR_HOME).toBe("/tmp/fake-home");
	}
	expect(
		launchChildren("auto", 4321, "d", "v", false, false)[0]?.command,
	).not.toContain("--fake");
	expect(fakeEnv().SIDECAR_HOME).toBe(FAKE_HOME);
	expect(FAKE_HOME.endsWith(join(".run", "fake-home"))).toBe(true);
});

test("mcp subcommand serves the study-sidecar tools over stdio", async () => {
	const child = Bun.spawn(
		[bunPath, join(import.meta.dir, "sidecar.ts"), "mcp"],
		{
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, SIDECAR_TOKEN: "unused", SIDECAR_PORT: "1" },
		},
	);
	const send = (message: object) =>
		child.stdin.write(`${JSON.stringify(message)}\n`);
	send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		},
	});
	send({ jsonrpc: "2.0", method: "notifications/initialized" });
	send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const responses = new Map<number, { result?: Record<string, unknown> }>();
	try {
		while (!responses.has(2) || !responses.has(3)) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value);
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					const message = JSON.parse(line);
					if (typeof message.id === "number")
						responses.set(message.id, message);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		child.kill();
		await child.exited;
	}
	const tools = (responses.get(2)?.result?.tools ?? []) as Array<{
		name: string;
	}>;
	expect(tools.map(({ name }) => name).sort()).toEqual([
		"tutor_ask",
		"tutor_note",
	]);
	const prompts = (responses.get(3)?.result?.prompts ?? []) as Array<{
		name: string;
	}>;
	expect(prompts.map(({ name }) => name)).toEqual(["tutor"]);
});
