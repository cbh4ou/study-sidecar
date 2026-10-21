import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Clean-HOME boot is the regression for the ENOENT crash in newestSession:
// the daemon must serve authed /health requests and never exit on its own.
// Readiness is a fixed free port plus HTTP polling: a bun-spawned child can
// buffer its stdout pipe indefinitely, so "daemon listening" on stdout is not
// a reliable in-test signal. Each poll awaits the actual HTTP response rather
// than a guessed duration.
test("boots with a clean HOME, requires auth, and keeps serving", async () => {
	const home = await mkdtemp(join(tmpdir(), "sidecar-boot-"));
	const probe = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data: () => {} },
	});
	const port = probe.port;
	probe.stop(true);
	const proc = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "index.ts"),
			"--harness",
			"auto",
			"--port",
			String(port),
		],
		{
			env: { HOME: home, PATH: process.env.PATH, SIDECAR_TOKEN: "test-token" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const base = `http://127.0.0.1:${port}`;
		let health: Response | undefined;
		for (let attempt = 0; attempt < 200 && !health?.ok; attempt += 1) {
			health = await fetch(`${base}/health`, {
				headers: { Authorization: "Bearer test-token" },
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);
			if (!health?.ok) {
				if (proc.exitCode !== null) {
					const stderr = await new Response(proc.stderr).text();
					throw new Error(`daemon exited before serving; stderr: ${stderr}`);
				}
				await Bun.sleep(100);
			}
		}
		expect(health?.status).toBe(200);
		expect(await health?.json()).toEqual({ ok: true, watched: null });
		const unauthed = await fetch(`${base}/health`, {
			signal: AbortSignal.timeout(2_000),
		});
		expect(unauthed.status).toBe(401);
		expect(proc.exitCode).toBeNull(); // still running with no sessions to watch
	} finally {
		proc.kill(9);
		await proc.exited;
		await rm(home, { recursive: true, force: true });
	}
}, 30_000);
