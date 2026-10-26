import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tutorAsk } from "./mcp/server.ts";
import { SourcePrivacy } from "./privacy/sources.ts";
import { parseClientMessage, parseDaemonMessage } from "./protocol.ts";
import { SettingsStore } from "./settings.ts";

test("new protocol boundaries reject invalid nested values", () => {
	for (const value of [
		{ type: "grade", cardId: "c", rating: "wrong" },
		{ type: "turn_telemetry", turnId: "t", tts_first_audio_ms: -1 },
		{ type: "answer", questionId: "q", value: 4 },
	])
		expect(parseClientMessage(value)).toBeUndefined();
	for (const value of [
		{
			type: "activity",
			jobs: [{ id: "j", kind: "bad", label: "x", status: "done" }],
		},
		{ type: "cards_due", count: -1 },
		{
			type: "deep_update",
			turnId: "t",
			documents: { scratchpad_diagram: { diagram: 4 } },
		},
		{
			type: "anchor_suggest",
			anchor: { kind: "pdf", path: "x", page: -1 },
			preview: "x",
		},
	])
		expect(parseDaemonMessage(value)).toBeUndefined();
});

test("MCP never returns the learner's answer", async () => {
	const result = await tutorAsk(
		{
			post: async () => ({
				status: "sent",
				ticket: "t",
				answer: "private answer",
			}),
		},
		{ question: "why?" },
	);
	expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
		status: "sent",
		ticket: "t",
	});
});

test("privacy covers realpaths; concurrent settings persist and reject corrupt input", async () => {
	const home = await mkdtemp(join(tmpdir(), "sidecar-privacy-"));
	try {
		const repo = join(home, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "secret"), "secret");
		await symlink(repo, join(home, "alias"));
		const privacy = new SourcePrivacy(join(home, "owned"));
		await privacy.set(repo, { local_only: true });
		expect(privacy.allowCloud(join(home, "alias", "secret"))).toBe(false);
		expect(privacy.allowCloud(join(repo, "..", "repo", "secret"))).toBe(false);
		expect(privacy.allowCloud(`${repo}-other`)).toBe(true);
		const store = new SettingsStore(join(home, "owned"));
		await store.load();
		await Promise.all([
			store.update({ follow: false }),
			store.update({ decide: { threshold: 0.8 } }),
			store.update({ hotkeys: { ptt: "Alt+F9" } }),
		]);
		const restored = new SettingsStore(join(home, "owned"));
		await restored.load();
		expect(restored.value.follow).toBe(false);
		expect(restored.value.hotkeys.ptt).toBe("Alt+F9");
		expect(restored.value.decide.threshold).toBe(0.8);
		await writeFile(store.path, '{"decide":{"threshold":"bad"}}');
		await restored.load();
		expect(restored.value.decide.threshold).toBe(0.7);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("full fake daemon registers features, streams both lanes, and owns its writes", async () => {
	const home = await mkdtemp(join(tmpdir(), "sidecar-mvp-"));
	const probe = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = probe.port;
	probe.stop(true);
	const child = Bun.spawn(
		[
			process.execPath,
			"--preload",
			join(import.meta.dir, "../../..", "scripts/audit-writes.ts"),
			join(import.meta.dir, "index.ts"),
			"--fake",
			"--port",
			String(port),
		],
		{
			env: {
				HOME: home,
				PATH: process.env.PATH,
				SIDECAR_HOME: join(home, "owned"),
				SIDECAR_TOKEN: "test",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const base = `http://127.0.0.1:${port}`;
	const api = async (path: string, body?: unknown) => {
		const response = await fetch(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: "Bearer test",
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		expect(response.ok).toBe(true);
		return response.json();
	};
	let ws: WebSocket | undefined;
	try {
		let ready = false;
		for (let i = 0; i < 150 && !ready; i++) {
			ready = await fetch(`${base}/health`, {
				headers: { Authorization: "Bearer test" },
			})
				.then((r) => r.ok)
				.catch(() => false);
			if (!ready) {
				if (child.exitCode !== null)
					throw new Error(await new Response(child.stderr).text());
				await Bun.sleep(25);
			}
		}
		expect(ready).toBe(true);
		for (const path of [
			"/api/settings",
			"/api/sources",
			"/api/graph",
			"/api/lessons",
			"/api/cards/due",
			"/api/telemetry",
			"/api/sessions",
			"/voice",
		])
			await api(path);
		const { lesson } = await api("/api/lessons", {
			goal: "Understand acknowledgements",
		});
		const frames: Array<Record<string, unknown>> = [];
		ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test`);
		ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
		await new Promise<void>((resolve, reject) => {
			if (!ws) return reject();
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("socket failed"));
		});
		ws.send(
			JSON.stringify({
				type: "question",
				text: "what is a channel ack?",
				lessonId: lesson.id,
			}),
		);
		for (let i = 0; i < 200; i++) {
			const transcript = frames.find(
				(f) => f.type === "transcript" && f.text === "what is a channel ack?",
			);
			if (
				transcript &&
				frames.some(
					(f) => f.type === "turn_settled" && f.turnId === transcript.turnId,
				)
			)
				break;
			await Bun.sleep(25);
		}
		for (const type of [
			"turn_started",
			"transcript",
			"fast_answer",
			"deep_update",
			"turn_settled",
		])
			expect(frames.some((f) => f.type === type)).toBe(true);
		expect((await api("/api/telemetry")).turns.length).toBeGreaterThan(0);
		const cards = (await api("/api/cards/due")).cards;
		expect(cards.length).toBeGreaterThan(0);
		const graph = await api("/api/graph");
		expect(
			graph.nodes.some(
				(node: { id: string }) => node.id === cards[0].propositionId,
			),
		).toBe(true);
		const detail = await api(`/api/lessons/${lesson.id}`);
		expect(detail.messages.length).toBeGreaterThan(0);
		expect(detail.questions.length).toBeGreaterThan(0);
		const ack = await api("/api/mcp/ask", {
			question: "what is a channel ack?",
		});
		expect(ack.status).toBe("sent");
		expect(ack.answer).toBeUndefined();
		await api("/api/mcp/note", {
			concept: "manual acknowledgements",
			why: "reliability",
		});
		await api("/api/sources", { path: "fake/session.jsonl", local_only: true });
		expect(
			await readFile(join(home, "owned", "sources.json"), "utf8"),
		).toContain("local_only");
		expect(await readdir(home)).toEqual(["owned"]);
	} finally {
		ws?.close();
		child.kill();
		await child.exited;
		const audited = JSON.parse(
			await readFile(join(home, "owned", ".write-audit.json"), "utf8"),
		);
		expect(audited.length).toBeGreaterThan(0);
		expect(
			audited.every((entry: { path: string }) =>
				entry.path.startsWith(join(home, "owned")),
			),
		).toBe(true);
		await rm(home, { recursive: true, force: true });
	}
}, 20000);

test("write audit rejects writes outside owned storage", async () => {
	const home = await mkdtemp(join(tmpdir(), "sidecar-write-guard-"));
	try {
		const outside = join(home, "outside");
		const child = Bun.spawn(
			[
				process.execPath,
				"--preload",
				join(import.meta.dir, "../../..", "scripts/audit-writes.ts"),
				"-e",
				`await Bun.write(${JSON.stringify(outside)},'forbidden')`,
			],
			{
				env: {
					HOME: home,
					PATH: process.env.PATH,
					SIDECAR_HOME: join(home, "owned"),
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				},
				stderr: "pipe",
				stdout: "ignore",
			},
		);
		expect(await child.exited).not.toBe(0);
		expect(await new Response(child.stderr).text()).toContain(
			"Write outside sidecar home",
		);
		expect(await Bun.file(outside).exists()).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("stored source flags honor local-only without graph field and fail closed on corruption", async () => {
	const root = await mkdtemp(join(tmpdir(), "sidecar-source-schema-"));
	try {
		await writeFile(
			join(root, "sources.json"),
			JSON.stringify({ "/private": { local_only: true } }),
		);
		const privacy = new SourcePrivacy(root);
		await privacy.load();
		expect(privacy.allowCloud("/private/file")).toBe(false);
		expect(privacy.indexIntoGraph("/private/file")).toBe(true);
		await writeFile(join(root, "sources.json"), "invalid json");
		const broken = new SourcePrivacy(root);
		await expect(broken.load()).rejects.toThrow();
		expect(broken.allowCloud("/anywhere")).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
