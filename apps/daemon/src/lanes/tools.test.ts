import { expect, test } from "bun:test";
import { ActivityRegistry } from "../activity.ts";
import { FakeLlm } from "../adapters/llm-fake.ts";
import { FakeWeb } from "../adapters/web-fake.ts";
import type { DaemonContext } from "../feature.ts";
import { FakeClock } from "../ports/clock.ts";
import type { DaemonMessage } from "../protocol.ts";
import { createDeepTools, runMetrics } from "./tools.ts";

test("run logs produce at most 200 numeric points from JSONL and CSV", () => {
	const rows = Array.from({ length: 1001 }, (_, step) =>
		JSON.stringify({ step, loss: 1 / (step + 1) }),
	).join("\n");
	const points = runMetrics(rows, "loss");
	expect(points.length).toBeLessThanOrEqual(200);
	expect(points[0]).toEqual({ step: 0, value: 1 });
	expect(runMetrics("step,loss\n1,0.5\n2,bad\n3,0.1", "loss")).toEqual([
		{ step: 1, value: 0.5 },
		{ step: 3, value: 0.1 },
	]);
});

test("research acknowledges before work, cites sources, and supports abort and privacy", async () => {
	const clock = new FakeClock(),
		web = new FakeWeb(),
		messages: DaemonMessage[] = [],
		mutations: string[] = [];
	const activity = new ActivityRegistry();
	let privateSource = false;
	const context = {
		fake: true,
		activity,
		broadcast: (message: DaemonMessage) => messages.push(message),
		watchedPath: () => "session",
		ports: { clock, web, llm: new FakeLlm({ delayMs: 0 }) },
		services: {
			privacy: { isLocalOnly: () => privateSource },
			learn: {
				activeLessonId: () => "lesson",
				lesson: async () => ({ anchors: [], sources: [] }),
				addSource: async () => {
					mutations.push("source");
				},
				appendMessage: async () => {
					mutations.push("prose");
				},
			},
		},
	} as unknown as DaemonContext;
	const search = createDeepTools(context).find(
		(tool) => tool.name === "web_search",
	);
	if (!search) throw new Error("missing web search");
	const ack = JSON.parse(
		await search.execute({ query: "channel acknowledgements" }),
	);
	expect(ack.status).toBe("queued");
	expect(activity.list()[0]?.status).toBe("running");
	expect(web.queries).toHaveLength(0);
	clock.advance(400);
	await Bun.sleep(0);
	await Bun.sleep(0);
	expect(web.queries).toHaveLength(1);
	expect(activity.list()[0]?.status).toBe("done");
	expect(mutations).toEqual(["source", "source", "source", "prose"]);
	expect(JSON.stringify(messages)).toContain(
		"https://www.rabbitmq.com/docs/confirms",
	);
	const stopped = JSON.parse(
		await search.execute({ query: "stop this research" }),
	);
	expect(activity.abort(stopped.jobId)).toBe(true);
	clock.advance(400);
	await Bun.sleep(0);
	expect(activity.list().find((job) => job.id === stopped.jobId)?.status).toBe(
		"error",
	);
	expect(web.queries).toHaveLength(1);
	privateSource = true;
	await expect(search.execute({ query: "private source" })).rejects.toThrow(
		"local-only",
	);
	expect(web.queries).toHaveLength(1);
});

test("file tools only read the attached repo and the lesson's own sources", async () => {
	const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const base = await mkdtemp(join(tmpdir(), "sidecar-tools-"));
	const repo = join(base, "repo");
	const elsewhere = join(base, "home");
	await mkdir(repo);
	await mkdir(elsewhere);
	const metrics = "step,loss\n1,0.5\n2,0.25";
	await writeFile(join(repo, "run.csv"), metrics);
	await writeFile(join(elsewhere, "secret.csv"), metrics);
	await writeFile(join(elsewhere, "added.csv"), metrics);
	const context = {
		fake: true,
		activity: new ActivityRegistry(),
		broadcast: () => undefined,
		watchedPath: () => "session",
		session: () => ({ id: "s", cwd: repo }),
		ports: {
			clock: new FakeClock(),
			web: new FakeWeb(),
			llm: new FakeLlm({ delayMs: 0, isCloud: true }),
		},
		services: {
			privacy: { isLocalOnly: () => false },
			learn: {
				activeLessonId: () => "lesson",
				lesson: async () => ({
					anchors: [],
					sources: [{ kind: "run", path: join(elsewhere, "added.csv") }],
				}),
			},
		},
	} as unknown as DaemonContext;
	const tool = createDeepTools(context).find(
		(spec) => spec.name === "read_run_metrics",
	);
	if (!tool) throw new Error("missing read_run_metrics");
	const read = (path: string) => tool.execute({ path, metric: "loss" });
	expect(JSON.parse(await read(join(repo, "run.csv")))).toHaveLength(2);
	expect(JSON.parse(await read(join(elsewhere, "added.csv")))).toHaveLength(2);
	await expect(read(join(elsewhere, "secret.csv"))).rejects.toThrow(
		/not part of the attached repository/,
	);
	await expect(read(join(repo, "..", "home", "secret.csv"))).rejects.toThrow(
		/not part of the attached repository/,
	);
});
