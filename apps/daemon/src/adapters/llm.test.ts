import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_SETTINGS, type StoredSettings } from "../settings.ts";
import type { PiModel } from "../tutor/provider.ts";
import { FakeLlm, registerFakeJsonResponder } from "./llm-fake.ts";
import {
	extractJson,
	isLoopbackUrl,
	laneModelSlug,
	PiLlm,
	type PiStreamImpl,
} from "./llm-pi.ts";

const SECRET = "sk-abcdefghijklmnopqrstuv";

function settings(lanes: StoredSettings["lanes"] = {}): {
	value: StoredSettings;
} {
	return { value: { ...structuredClone(DEFAULT_SETTINGS), lanes } };
}

const registry = new Map<string, PiModel>([
	[
		"cloud/big",
		{
			slug: "cloud/big",
			modelId: "big",
			provider: "cloud",
			baseUrl: "https://api.example.com/v1",
		},
	],
	[
		"local/small",
		{
			slug: "local/small",
			modelId: "small",
			provider: "local",
			baseUrl: "http://127.0.0.1:8080/v1",
		},
	],
]);

function capture(reply: string): {
	impl: PiStreamImpl;
	contexts: Context[];
	keys: string[];
} {
	const contexts: Context[] = [];
	const keys: string[] = [];
	const impl: PiStreamImpl = async function* (_model, context, options) {
		contexts.push(context);
		keys.push(options.apiKey);
		for (const delta of [reply.slice(0, 3), reply.slice(3)])
			yield { type: "text_delta", delta } as AssistantMessageEvent;
	};
	return { impl, contexts, keys };
}

describe("llm-pi pure parts", () => {
	test("lane model selection falls back to the daemon slug", () => {
		const value = settings({ fast: "local/small" }).value;
		expect(laneModelSlug(value, "fast", "cloud/big")).toBe("local/small");
		expect(laneModelSlug(value, "deep", "cloud/big")).toBe("cloud/big");
		expect(laneModelSlug(value, "deep")).toBeUndefined();
		expect(laneModelSlug(settings({ deep: "  " }).value, "deep", "x/y")).toBe(
			"x/y",
		);
	});

	test("loopback detection", () => {
		expect(isLoopbackUrl("http://127.0.0.1:8080/v1")).toBe(true);
		expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
		expect(isLoopbackUrl("http://[::1]:8000/v1")).toBe(true);
		expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
		expect(isLoopbackUrl("http://192.168.1.4:8080")).toBe(false);
		expect(isLoopbackUrl("not a url")).toBe(false);
	});

	test("json fence stripping", () => {
		expect(extractJson('```json\n{"choice":"a","confidence":0.5}\n```')).toBe(
			'{"choice":"a","confidence":0.5}',
		);
		expect(extractJson('Sure! {"a": [1, 2]} hope that helps')).toBe(
			'{"a":[1,2]}',
		);
		expect(extractJson("[1,2]")).toBe("[1,2]");
		expect(() => extractJson("no json here")).toThrow("valid JSON");
	});

	test("isCloud follows lane settings at call time", async () => {
		const store = settings({ fast: "local/small", deep: "local/small" });
		const llm = await new PiLlm({
			home: "/nowhere",
			settings: store,
			registry: async () => registry,
		}).init();
		expect(llm.isCloud).toBe(false);
		store.value.lanes.deep = "cloud/big";
		expect(llm.isCloud).toBe(true);
		store.value.lanes.deep = "unknown/model";
		expect(llm.isCloud).toBe(true);
	});

	test("default model selection updates at use time without recreating ports", async () => {
		let current: string | undefined = "cloud/big";
		const used: string[] = [];
		const llm = await new PiLlm({
			home: "/fixture",
			settings: settings(),
			modelSlug: "cloud/big",
			getModelSlug: () => current,
			registry: async () => registry,
			credential: async () => "test",
			streamImpl: async function* (model) {
				used.push(model.id);
				yield { type: "text_delta", delta: "reply" } as AssistantMessageEvent;
			},
		}).init();
		expect(llm.isCloud).toBe(true);
		await llm.complete({ lane: "deep", system: "test", messages: [] });
		current = "local/small";
		expect(llm.isCloud).toBe(false);
		await llm.complete({ lane: "deep", system: "test", messages: [] });
		expect(used).toEqual(["big", "small"]);
		current = undefined;
		await expect(
			llm.complete({ lane: "deep", system: "test", messages: [] }),
		).rejects.toThrow("No model configured");
	});

	test("fast lane defaults to cheapest authenticated model", async () => {
		const models = new Map<string, PiModel>([
			[
				"cloud/expensive",
				{
					slug: "cloud/expensive",
					modelId: "expensive",
					provider: "cloud",
					baseUrl: "https://api.example.test",
					cost: { input: 10, output: 20 },
				},
			],
			[
				"cloud/cheap",
				{
					slug: "cloud/cheap",
					modelId: "cheap",
					provider: "cloud",
					baseUrl: "https://api.example.test",
					cost: { input: 0.1, output: 0.2 },
				},
			],
			[
				"missing/free",
				{
					slug: "missing/free",
					modelId: "free",
					provider: "missing",
					baseUrl: "https://api.example.test",
					cost: { input: 0, output: 0 },
				},
			],
		]);
		const used: string[] = [];
		const llm = await new PiLlm({
			home: "/fixture",
			settings: settings(),
			modelSlug: "cloud/expensive",
			registry: async () => models,
			credential: async (_home, provider) => {
				if (provider === "missing") throw new Error("no auth");
				return "test";
			},
			streamImpl: async function* (model) {
				used.push(model.id);
				yield { type: "text_delta", delta: "reply" } as AssistantMessageEvent;
			},
		}).init();
		await llm.complete({ lane: "fast", system: "test", messages: [] });
		await llm.complete({ lane: "deep", system: "test", messages: [] });
		expect(used).toEqual(["cheap", "expensive"]);
	});

	test("structured completions declare one required submit tool and consume its arguments", async () => {
		let sent: Context | undefined;
		let choice: string | undefined;
		const llm = await new PiLlm({
			home: "/fixture",
			settings: settings({ deep: "cloud/big" }),
			registry: async () => registry,
			credential: async () => "test",
			streamImpl: async function* (_model, context, options) {
				sent = context;
				choice = options.toolChoice;
				const toolCall = fauxToolCall("submit_graph", {
					propositions: [{ statement: "An ack confirms handling" }],
					chains: [],
				});
				const message = fauxAssistantMessage([toolCall], {
					stopReason: "toolUse",
				});
				yield {
					type: "toolcall_end",
					toolCall,
					partial: message,
					contentIndex: 0,
				};
				yield { type: "done", reason: "toolUse", message };
			},
		}).init();
		const reply = await llm.complete({
			lane: "deep",
			system: "Extract claims",
			messages: [{ role: "user", content: "A channel ack confirms handling" }],
			json: true,
			submit: {
				name: "submit_graph",
				description: "Submit the extracted claims",
				parameters: {
					type: "object",
					properties: {
						propositions: { type: "array" },
						chains: { type: "array" },
					},
					required: ["propositions", "chains"],
				},
			},
		});
		expect(choice).toBe("required");
		expect(sent?.tools?.map((tool) => tool.name)).toEqual(["submit_graph"]);
		expect(sent?.systemPrompt).toContain("Call submit_graph");
		expect(sent?.systemPrompt).not.toContain("Reply with exactly one JSON");
		expect(JSON.parse(reply).propositions[0].statement).toBe(
			"An ack confirms handling",
		);
	});

	test("native auditor read calls become one deduplicated read-only envelope", async () => {
		let declared: string[] = [];
		const llm = await new PiLlm({
			home: "/fixture",
			settings: settings({ deep: "cloud/big" }),
			registry: async () => registry,
			credential: async () => "test",
			streamImpl: async function* (_model, context) {
				declared = context.tools?.map((tool) => tool.name) ?? [];
				const find = fauxToolCall("find", { text: "ack" }, { id: "read-1" });
				const list = fauxToolCall(
					"list_propositions",
					{ sourceId: "lesson" },
					{ id: "read-2" },
				);
				const message = fauxAssistantMessage([find, list], {
					stopReason: "toolUse",
				});
				yield {
					type: "toolcall_end",
					toolCall: find,
					partial: message,
					contentIndex: 0,
				};
				yield {
					type: "toolcall_end",
					toolCall: list,
					partial: message,
					contentIndex: 1,
				};
				yield { type: "done", reason: "toolUse", message };
			},
		}).init();
		const reply = await llm.complete({
			lane: "deep",
			system: "Audit identities",
			messages: [],
			json: true,
			submit: {
				name: "submit_audit",
				parameters: {
					type: "object",
					properties: { links: { type: "array" } },
				},
			},
			readTools: [
				{
					name: "find",
					parameters: {
						type: "object",
						properties: { text: { type: "string" } },
					},
				},
				{
					name: "list_propositions",
					parameters: {
						type: "object",
						properties: { sourceId: { type: "string" } },
					},
				},
			],
		});
		expect(declared).toEqual(["submit_audit", "find", "list_propositions"]);
		expect(JSON.parse(reply)).toEqual({
			calls: [
				{ tool: "find", text: "ack" },
				{ tool: "list_propositions", sourceId: "lesson" },
			],
		});
	});

	test("missing model and missing auth throw clear errors", async () => {
		const llm = new PiLlm({
			home: "/nowhere",
			settings: settings(),
			registry: async () => registry,
		});
		await expect(
			llm.complete({ lane: "fast", system: "", messages: [] }),
		).rejects.toThrow("No model configured for the fast lane");
		const noAuth = new PiLlm({
			home: "/nowhere",
			settings: settings({ fast: "cloud/big" }),
			registry: async () => registry,
		});
		await expect(
			noAuth.complete({ lane: "fast", system: "", messages: [] }),
		).rejects.toThrow("No Pi authentication for cloud");
	});

	test("cloud lane redacts every string (T2)", async () => {
		const { impl, contexts, keys } = capture('```json\n{"ok":true}\n```');
		const llm = new PiLlm({
			home: "/nowhere",
			settings: settings({ fast: "cloud/big" }),
			registry: async () => registry,
			credential: async () => "pi-key",
			streamImpl: impl,
		});
		const reply = await llm.complete({
			lane: "fast",
			json: true,
			system: `system with ${SECRET}`,
			messages: [
				{ role: "user", content: `token=hunter2 and ${SECRET}` },
				{ role: "assistant", content: `password: p4ss ${SECRET}` },
			],
		});
		expect(reply).toBe('{"ok":true}');
		expect(keys).toEqual(["pi-key"]);
		const sent = JSON.stringify(contexts[0]);
		expect(sent).not.toContain("abcdefghijklmnopqrstuv");
		expect(sent).not.toContain("hunter2");
		expect(sent).not.toContain("p4ss");
		expect(sent).toContain("sk-***");
	});

	test("loopback lane leaves text untouched and streams deltas", async () => {
		const { impl, contexts } = capture("hello world");
		const llm = new PiLlm({
			home: "/nowhere",
			settings: settings({ deep: "local/small" }),
			registry: async () => registry,
			credential: async () => "k",
			streamImpl: impl,
		});
		const chunks: string[] = [];
		for await (const chunk of llm.stream({
			lane: "deep",
			system: "s",
			messages: [{ role: "user", content: SECRET }],
		}))
			chunks.push(chunk);
		expect(chunks.join("")).toBe("hello world");
		expect(JSON.stringify(contexts[0])).toContain(SECRET);
	});
});

describe("FakeLlm", () => {
	test("fast lane answers in chunks", async () => {
		const llm = new FakeLlm({ delayMs: 0 });
		const chunks: string[] = [];
		for await (const chunk of llm.stream({
			lane: "fast",
			system: "",
			messages: [{ role: "user", content: "  what is a channel ack?  " }],
		}))
			chunks.push(chunk);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.length).toBeLessThanOrEqual(3);
		expect(chunks.join("")).toBe("Fake answer to: what is a channel ack.");
	});

	test("deep lane includes a mermaid sequence diagram", async () => {
		const text = await new FakeLlm({ delayMs: 0 }).complete({
			lane: "deep",
			system: "",
			messages: [{ role: "user", content: "explain acks" }],
		});
		expect(text).toContain("```mermaid\nsequenceDiagram");
	});

	test("json replies default to {} and honor responders", async () => {
		const llm = new FakeLlm({ delayMs: 0 });
		const request = {
			lane: "fast" as const,
			json: true,
			system: "extractor",
			messages: [],
		};
		expect(await llm.complete(request)).toBe("{}");
		const off = registerFakeJsonResponder(
			(req) => req.system === "extractor",
			() => ({ propositions: [] }),
		);
		expect(JSON.parse(await llm.complete(request))).toEqual({
			propositions: [],
		});
		off();
		expect(await llm.complete(request)).toBe("{}");
	});
});
