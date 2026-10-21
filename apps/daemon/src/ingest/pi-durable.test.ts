import { describe, expect, test } from "bun:test";
import {
	parseSseStream,
	streamDurableSession,
	superviseDurableSession,
} from "./pi-durable.ts";

const encoder = new TextEncoder();

test("prefers the agent-scoped read-only URL and falls back to legacy on 404", async () => {
	const paths: string[] = [];
	const statuses: number[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			paths.push(new URL(request.url).pathname + new URL(request.url).search);
			statuses.push(200);
			if (paths.length === 1) return new Response("missing", { status: 404 });
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode('event: hello\ndata: {"id":"legacy"}\n\n'),
					);
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	try {
		const connected = await streamDurableSession(
			`http://127.0.0.1:${server.port}`,
			"legacy-1",
			{ onEvent() {} },
			async () => {
				throw new Error("fallback should not run");
			},
			"omp",
		);
		expect(connected).toBe(true);
		expect(paths).toEqual([
			"/v1/sessions/legacy-1/agents/omp?read_only=true",
			"/v1/sessions/legacy-1",
		]);
	} finally {
		server.stop(true);
	}
});

test("parses hello, snapshot, and a chunk-split delta", async () => {
	const server = Bun.serve({
		port: 0,
		fetch() {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode('event: hello\ndata: {"id":"durable-1"}\n\n'),
					);
					controller.enqueue(
						encoder.encode(
							'event: snapshot\ndata: {"events":[{"type":"message","message":{"role":"user","content":"snapshot"}}]}\n\n',
						),
					);
					controller.enqueue(
						encoder.encode(
							'event: delta\ndata: {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"del',
						),
					);
					controller.enqueue(encoder.encode('ta"}]}}\n\n'));
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	try {
		const events: string[] = [];
		const sessions: string[] = [];
		const connected = await streamDurableSession(
			`http://127.0.0.1:${server.port}`,
			"durable-1",
			{
				onEvent: (event) => events.push(event.headline),
				onSession: (session) => sessions.push(session.id),
			},
			async () => {
				throw new Error("fallback should not run");
			},
		);
		expect(connected).toBe(true);
		expect(sessions).toEqual(["durable-1"]);
		expect(events).toEqual(["User: snapshot", "Agent: delta"]);
	} finally {
		server.stop(true);
	}
});

test("enriches Durable events with JSONL provenance and Tier-0 details", async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					[
						'data: {"type":"message","message":{"role":"assistant","timestamp":"2026-01-01T00:00:00.000Z","content":[{"type":"toolCall","name":"write","id":"call-1","arguments":{"path":"a.py","content":"try:\\n  work()\\nexcept:\\n  pass"}},{"type":"toolCall","name":"edit","id":"call-2","arguments":{"path":"b.py","oldString":"x = 1","newString":"async def run():\\n  pass"}}]}}\n\n',
						'data: {"type":"message","message":{"role":"toolResult","timestamp":"2026-01-01T00:00:01.000Z","toolName":"bash","toolCallId":"call-2","content":[{"type":"text","text":"one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight\\nnine"}]}}\n\n',
					].join(""),
				),
			);
			controller.close();
		},
	});
	const events: Record<string, unknown>[] = [];
	await parseSseStream(
		stream,
		{ onEvent: (event) => events.push(event) },
		{ sessionFile: "/sessions/durable-1.jsonl" },
	);
	expect(events[0]).toMatchObject({
		id: "2026-01-01T00:00:00.000Z:1",
		session_file: "/sessions/durable-1.jsonl",
		diff: "try:\n  work()\nexcept:\n  pass",
		signals: ["silent exception swallowing (`except: pass`)"],
	});
	expect(events[1]).toMatchObject({
		id: "2026-01-01T00:00:00.000Z:2",
		session_file: "/sessions/durable-1.jsonl",
		diff: expect.stringContaining("@@ edit b.py"),
	});
	expect(events[2]).toMatchObject({
		id: "2026-01-01T00:00:01.000Z:3",
		session_file: "/sessions/durable-1.jsonl",
		bash_tail: "two\nthree\nfour\nfive\nsix\nseven\neight\nnine",
	});
});

test("falls back when Durable returns an error", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response("offline", { status: 503 }),
	});
	try {
		let fallback = false;
		const connected = await streamDurableSession(
			`http://127.0.0.1:${server.port}`,
			"missing",
			{ onEvent() {} },
			async () => {
				fallback = true;
			},
		);
		expect(connected).toBe(false);
		expect(fallback).toBe(true);
	} finally {
		server.stop(true);
	}
});

describe("superviseDurableSession", () => {
	test("reconnects after a clean stream end with doubling, capped backoff", async () => {
		let connects = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				connects += 1;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode('event: hello\ndata: {"id":"s"}\n\n'),
						);
						controller.close();
					},
				});
				return new Response(stream, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		try {
			const sleeps: number[] = [];
			await superviseDurableSession(
				`http://127.0.0.1:${server.port}`,
				"s",
				{ onEvent() {} },
				async () => {
					throw new Error("fallback should not run");
				},
				{
					baseMs: 10,
					maxMs: 40,
					sleep: async (milliseconds) => {
						sleeps.push(milliseconds);
					},
					shouldStop: () => connects >= 4,
				},
			);
			expect(connects).toBe(4);
			expect(sleeps).toEqual([10, 20, 40]);
		} finally {
			server.stop(true);
		}
	});

	test("runs the fallback poll on connect failure and retries", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("down", { status: 503 }),
		});
		try {
			let fallbacks = 0;
			await superviseDurableSession(
				`http://127.0.0.1:${server.port}`,
				"x",
				{ onEvent() {} },
				async () => {
					fallbacks += 1;
				},
				{
					baseMs: 5,
					maxMs: 10,
					sleep: async () => {},
					shouldStop: () => fallbacks >= 2,
				},
			);
			expect(fallbacks).toBe(2);
		} finally {
			server.stop(true);
		}
	});
});

describe("byte bounds", () => {
	test("discards a partial SSE line over 64 KiB and keeps later events", async () => {
		const big = "x".repeat(70 * 1024);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${big}`)); // no newline yet
				controller.enqueue(
					encoder.encode(
						'\n\ndata: {"type":"message","message":{"role":"user","content":"after"}}\n\n',
					),
				);
				controller.close();
			},
		});
		const headlines: string[] = [];
		const errors: string[] = [];
		await parseSseStream(stream, {
			onEvent: (event) => headlines.push(event.headline),
			onError: (message) => errors.push(message),
		});
		expect(headlines).toEqual(["User: after"]);
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});

	test("drops an SSE event whose data exceeds 1 MiB", async () => {
		const piece = "y".repeat(60 * 1024);
		const parts = Array.from({ length: 20 }, () => `data: ${piece}\n`);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`${parts.join("")}\n`));
				controller.enqueue(
					encoder.encode(
						'data: {"type":"message","message":{"role":"user","content":"kept"}}\n\n',
					),
				);
				controller.close();
			},
		});
		const headlines: string[] = [];
		const errors: string[] = [];
		await parseSseStream(stream, {
			onEvent: (event) => headlines.push(event.headline),
			onError: (message) => errors.push(message),
		});
		expect(headlines).toEqual(["User: kept"]);
		expect(errors).toHaveLength(1);
	});
});
