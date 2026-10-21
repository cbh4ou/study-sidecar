import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type IngestHost,
	IngestManager,
	newestSession,
	sessionDirectories,
} from "./manager.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "sidecar-manager-"));
	directories.push(home);
	return home;
}

describe("newestSession", () => {
	test("returns undefined when harness directories are missing", async () => {
		const home = await temporaryHome();
		expect(
			await newestSession(sessionDirectories(home), "auto"),
		).toBeUndefined();
	});
	test("finds a Hermes SQLite session without changing its transcript", async () => {
		const home = await temporaryHome();
		const directory = join(home, ".hermes");
		await mkdir(directory);
		const path = join(directory, "state.db");
		const db = new Database(path);
		db.exec(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT)",
		);
		db.exec(
			"CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT)",
		);
		db.query("INSERT INTO sessions VALUES (?, ?, ?)").run(
			"h1",
			"/tmp/project",
			"Learn tests",
		);
		db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			1,
			"h1",
			"user",
			"Why test?",
			null,
			null,
			Date.now() / 1000,
			null,
		);
		db.close();
		const before = await Bun.file(path).bytes();
		const candidate = await newestSession(sessionDirectories(home), "hermes");
		expect(candidate?.sessionId).toBe("h1");
		const events: string[] = [];
		const sessions: string[] = [];
		const manager = new IngestManager(
			{
				onEvent: (event) => events.push(event.headline),
				onSession: (session) => sessions.push(session.id),
				broadcast() {},
				reset() {},
				watched() {},
				hydrate() {},
			},
			{ harness: "hermes", directories: sessionDirectories(home) },
		);
		try {
			await manager.rescan();
			expect(sessions).toEqual(["h1"]);
			expect(events).toEqual(["User: Why test?"]);
			expect(await Bun.file(path).bytes()).toEqual(before);
			const writer = new Database(path);
			writer
				.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					2,
					"h1",
					"tool",
					"42 lines of output",
					null,
					"read",
					Date.now() / 1000 + 1,
					null,
				);
			writer.close();
			await Bun.sleep(550);
			expect(events.at(-1)).toContain("[receipt]");
			const next = new Database(path);
			next
				.query("INSERT INTO sessions VALUES (?, ?, ?)")
				.run("h2", "/tmp/next", "Next task");
			next
				.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					3,
					"h2",
					"user",
					"New task",
					null,
					null,
					Date.now() / 1000 + 2,
					null,
				);
			next.close();
			await manager.rescan();
			expect(sessions).toEqual(["h1", "h2"]);
			expect(events.at(-1)).toBe("User: New task");
		} finally {
			manager.stop();
		}
	});
});

describe("IngestManager", () => {
	test("re-discovers and rotates to a newer transcript", async () => {
		const home = await temporaryHome();
		const piDirectory = join(home, ".pi/agent/sessions");
		await mkdir(piDirectory, { recursive: true });
		const first = join(piDirectory, "a.jsonl");
		await writeFile(
			first,
			'{"type":"session","id":"a"}\n{"type":"message","message":{"role":"user","content":"first"}}\n',
		);
		const headlines: string[] = [];
		const sessionIds: string[] = [];
		const initPaths: string[] = [];
		const watchedPaths: string[] = [];
		let resets = 0;
		let hydrating = false;
		const host: IngestHost = {
			onEvent: (event) => headlines.push(event.headline),
			onSession: (session) => sessionIds.push(session.id),
			broadcast: (message) => {
				if (
					message &&
					typeof message === "object" &&
					"type" in message &&
					message.type === "session_init" &&
					"transcript_path" in message &&
					typeof message.transcript_path === "string"
				) {
					initPaths.push(message.transcript_path);
				}
			},
			reset: () => {
				resets += 1;
				headlines.length = 0;
				sessionIds.length = 0;
			},
			watched: (path) => watchedPaths.push(path),
			hydrate: (value) => {
				hydrating = value;
			},
		};
		const manager = new IngestManager(host, {
			harness: "auto",
			directories: sessionDirectories(home),
		});
		try {
			await manager.rescan();
			expect(watchedPaths).toEqual([first]);
			expect(initPaths).toEqual([first]);
			expect(sessionIds).toEqual(["a"]);
			expect(headlines).toEqual(["User: first"]);
			expect(hydrating).toBe(false);

			const second = join(piDirectory, "b.jsonl");
			await writeFile(
				second,
				'{"type":"session","id":"b"}\n{"type":"message","message":{"role":"user","content":"second"}}\n',
			);
			await manager.rescan();
			expect(resets).toBe(2);
			expect(watchedPaths).toEqual([first, second]);
			expect(initPaths).toEqual([first, second]);
			expect(sessionIds).toEqual(["b"]);
			expect(headlines).toEqual(["User: second"]);
		} finally {
			manager.stop();
		}
	});

	test("aborts the rotated durable stream and only coaches delta events", async () => {
		const home = await temporaryHome();
		const piDirectory = join(home, ".pi/agent/sessions");
		await mkdir(piDirectory, { recursive: true });
		const first = join(piDirectory, "a.jsonl");
		const second = join(piDirectory, "b.jsonl");
		await writeFile(first, '{"type":"session","id":"a"}\n');
		const encoder = new TextEncoder();
		let durableRequests = 0;
		const { promise: firstConnected, resolve: resolveFirst } =
			Promise.withResolvers<void>();
		const { promise: firstAborted, resolve: resolveAborted } =
			Promise.withResolvers<void>();
		const { promise: deltaCoached, resolve: resolveDelta } =
			Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			fetch() {
				durableRequests += 1;
				const secondSession = durableRequests >= 2;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						if (!secondSession) {
							controller.enqueue(
								encoder.encode('event: hello\ndata: {"id":"a"}\n\n'),
							);
							resolveFirst();
							return; // first stream stays open until the client aborts
						}
						controller.enqueue(
							encoder.encode(
								'event: snapshot\ndata: {"type":"message","message":{"role":"user","content":"historic"}}\n\n',
							),
						);
						controller.enqueue(
							encoder.encode(
								'event: delta\ndata: {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"live"}]}}\n\n',
							),
						);
						controller.close();
					},
				});
				return new Response(stream, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const realFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async (input, init) => {
			const call = ++fetchCalls;
			init?.signal?.addEventListener("abort", () => {
				if (call === 1) resolveAborted();
			});
			return realFetch(input, init);
		}) as typeof fetch;
		let hydrating = false;
		const coached: string[] = [];
		const host: IngestHost = {
			onEvent: (event) => {
				if (hydrating) return;
				coached.push(event.headline);
				if (event.headline === "Agent: live") resolveDelta();
			},
			onSession() {},
			broadcast() {},
			reset() {},
			watched() {},
			hydrate: (value) => {
				hydrating = value;
			},
		};
		const manager = new IngestManager(host, {
			harness: "pi",
			directories: sessionDirectories(home),
			durableUrl: `http://127.0.0.1:${server.port}`,
		});
		try {
			await manager.rescan();
			await firstConnected;
			await writeFile(second, '{"type":"session","id":"b"}\n');
			await utimes(second, new Date(), new Date(Date.now() + 1_000));
			await manager.rescan();
			await firstAborted;
			await deltaCoached;
			expect(coached).toEqual(["Agent: live"]);
		} finally {
			manager.stop();
			globalThis.fetch = realFetch;
			server.stop(true);
		}
	});
});
