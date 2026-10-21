import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "./events.ts";

import { enrichEvent, normalizePiRecord, PiTailer } from "./pi-jsonl.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "sidecar-tailer-"));
	directories.push(directory);
	return join(directory, "session.jsonl");
}

describe("PiTailer", () => {
	test("waits for a complete newline-delimited record", async () => {
		const path = await fixture();
		const events: string[] = [];
		const tailer = new PiTailer(path, {
			onEvent: (event) => events.push(event.headline),
		});
		await writeFile(
			path,
			'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hel',
		);
		await tailer.poll();
		expect(events).toEqual([]);
		await appendFile(path, 'lo"}]}}\n');
		await tailer.poll();
		expect(events).toEqual(["User: hello"]);
	});

	test("resets when the file is truncated", async () => {
		const path = await fixture();
		const events: string[] = [];
		const tailer = new PiTailer(path, {
			onEvent: (event) => events.push(event.headline),
		});
		await writeFile(
			path,
			'{"type":"message","message":{"role":"user","content":"a much longer first message"}}\n',
		);
		await tailer.poll();
		await writeFile(
			path,
			'{"type":"message","message":{"role":"user","content":"new"}}\n',
		);
		await tailer.poll();
		expect(events).toEqual(["User: a much longer first message", "User: new"]);
	});

	test("resets when atomic replacement changes the inode", async () => {
		const path = await fixture();
		const events: string[] = [];
		const tailer = new PiTailer(path, {
			onEvent: (event) => events.push(event.headline),
		});
		await writeFile(
			path,
			'{"type":"message","message":{"role":"user","content":"first"}}\n',
		);
		await tailer.poll();
		const replacement = `${path}.next`;
		await writeFile(
			replacement,
			'{"type":"message","message":{"role":"user","content":"second"}}\n',
		);
		await rename(replacement, path);
		await tailer.poll();
		expect(events).toEqual(["User: first", "User: second"]);
	});

	test("skips an oversized line and parses the records after it", async () => {
		const path = await fixture();
		const events: string[] = [];
		const errors: string[] = [];
		const tailer = new PiTailer(path, {
			onEvent: (event) => events.push(event.headline),
			onError: (message) => errors.push(message),
		});
		const filler = "x".repeat(1024 * 1024 + 512);
		await writeFile(
			path,
			`{"pad":"${filler}"}\n{"type":"message","message":{"role":"user","content":"after"}}\n`,
		);
		await tailer.poll();
		expect(events).toEqual(["User: after"]);
		expect(errors).toHaveLength(1);
	});

	test("bounds the fragment while a line stays unterminated past 1 MiB", async () => {
		const path = await fixture();
		const events: string[] = [];
		const errors: string[] = [];
		const tailer = new PiTailer(path, {
			onEvent: (event) => events.push(event.headline),
			onError: (message) => errors.push(message),
		});
		const filler = "x".repeat(2 * 1024 * 1024);
		await writeFile(path, `{"pad":"${filler}"}`); // no terminating newline
		await tailer.poll();
		expect(events).toEqual([]);
		expect(errors.length).toBeGreaterThanOrEqual(1);
		await appendFile(
			path,
			'\n{"type":"message","message":{"role":"user","content":"later"}}\n',
		);
		await tailer.poll();
		expect(events).toEqual(["User: later"]);
	});
});

test("enrichEvent assigns incrementing provenance", () => {
	let sequence = 0;
	const state = { file: "/sessions/one.jsonl", seq: () => ++sequence };
	const event = {
		timestamp: "2026-01-01T00:00:00.000Z",
		event_type: "agent_message" as const,
		headline: "Agent: hi",
		details: "hi",
	};
	expect(enrichEvent(event, state)).toMatchObject({
		id: "2026-01-01T00:00:00.000Z:1",
		session_file: "/sessions/one.jsonl",
	});
	expect(enrichEvent(event, state)).toMatchObject({
		id: "2026-01-01T00:00:00.000Z:2",
		session_file: "/sessions/one.jsonl",
	});
});

test("labels Write and Edit declarations with the affected symbol", () => {
	const write = normalizePiRecord({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "write",
					arguments: { path: "new.ts", content: "function make() {}" },
				},
			],
		},
	});
	const edit = normalizePiRecord({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "edit",
					arguments: {
						path: "a.py",
						oldString: "x = 1",
						newString: "async def run():\\n  pass",
					},
				},
			],
		},
	});
	expect(write.events[0]?.headline).toBe("@@ new file: new.ts");
	expect(edit.events[0]?.headline).toBe("@@ a.py :: async def run");
});

test("enriches tailed events with stable provenance and Tier-0 details", async () => {
	const path = await fixture();
	const events: SessionEvent[] = [];
	const tailer = new PiTailer(path, { onEvent: (event) => events.push(event) });
	await writeFile(
		path,
		[
			'{"type":"message","message":{"role":"assistant","timestamp":"2026-01-01T00:00:00.000Z","content":[{"type":"toolCall","name":"write","id":"call-1","arguments":{"path":"a.py","content":"try:\\n  work()\\nexcept:\\n  pass"}}]}}',
			'{"type":"message","message":{"role":"toolResult","timestamp":"2026-01-01T00:00:01.000Z","toolName":"bash","toolCallId":"call-1","content":[{"type":"text","text":"one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\neight\\nnine"}]}}',
			"",
		].join("\n"),
	);
	await tailer.poll();
	expect(events[0]).toMatchObject({
		id: "2026-01-01T00:00:00.000Z:1",
		session_file: path,
		diff: "try:\n  work()\nexcept:\n  pass",
		signals: ["silent exception swallowing (`except: pass`)"],
	});
	expect(events[1]).toMatchObject({
		id: "2026-01-01T00:00:01.000Z:2",
		session_file: path,
		bash_tail: "two\nthree\nfour\nfive\nsix\nseven\neight\nnine",
	});
});

test("strips ANSI color codes from headlines and details", () => {
	const [event] = normalizePiRecord({
		type: "message",
		message: {
			role: "assistant",
			timestamp: "2026-10-20T11:00:00Z",
			content: [
				{
					type: "thinking",
					thinking: "\x1b[38;2;167;152;215mThinking:\x1b[39m deep",
				},
				{ type: "text", text: "\x1b[1mbold answer\x1b[0m" },
			],
		},
	}).events;
	expect(event.headline).toBe("Thought: Thinking: deep");
	expect(event.details).toBe("Thinking: deep");
});
