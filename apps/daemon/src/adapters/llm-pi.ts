import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Lane, LlmPort, LlmRequest } from "../ports/llm.ts";
import type { StoredSettings } from "../settings.ts";
import {
	loadPiRegistry,
	type PiModel,
	piCredential,
	TutorModelError,
} from "../tutor/provider.ts";
import { redact } from "../tutor/redact.ts";

const PROVIDER_ID = "sidecar-lanes";

/** Normalized pi-ai stream entry point (injectable for tests). */
export type PiStreamImpl = (
	model: Model<"openai-completions">,
	context: Context,
	options: { apiKey: string; signal?: AbortSignal; maxTokens?: number },
) => AsyncIterable<AssistantMessageEvent>;

export type LlmPiOptions = {
	home: string;
	settings: { readonly value: StoredSettings };
	/** The daemon's `--model` / `SIDECAR_MODEL` slug; used when a lane has none. */
	modelSlug?: string;
	registry?: (home: string) => Promise<Map<string, PiModel>>;
	credential?: (home: string, provider: string) => Promise<string>;
	streamImpl?: PiStreamImpl;
};

/** The Pi slug a lane uses right now: lane setting, then the daemon default. */
export function laneModelSlug(
	settings: StoredSettings,
	lane: Lane,
	fallback?: string,
): string | undefined {
	const slug = settings.lanes[lane]?.trim() || fallback?.trim();
	return slug || undefined;
}

/** True when the URL's host is a loopback address. */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	host = host.replace(/^\[|\]$/g, "");
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

/**
 * Pull exactly one JSON value out of a model reply: strips Markdown code
 * fences and surrounding prose, parses it, and returns it re-serialized.
 */
export function extractJson(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json|JSON)?\s*\r?\n?([\s\S]*?)```/);
	const body = (fenced?.[1] ?? trimmed).trim();
	const attempts = [body];
	const start = body.search(/[{[]/);
	if (start >= 0) {
		const open = body[start];
		const close = open === "{" ? "}" : "]";
		const end = body.lastIndexOf(close);
		if (end > start) attempts.push(body.slice(start, end + 1));
	}
	for (const attempt of attempts) {
		try {
			return JSON.stringify(JSON.parse(attempt));
		} catch {
			// try the next candidate
		}
	}
	throw new Error(
		`model did not return valid JSON: ${trimmed.slice(0, 120) || "(empty reply)"}`,
	);
}

/** Build the pi-ai Context, redacting every string when the model is cloud. */
export function buildContext(
	request: LlmRequest & { json?: boolean },
	model: Model<"openai-completions">,
	cloud: boolean,
	now = Date.now(),
): Context {
	const clean = (text: string) => (cloud ? redact(text) : text);
	const jsonRule = request.json
		? "\n\nReply with exactly one JSON value and nothing else."
		: "";
	const messages: Message[] = request.messages.map((message): Message => {
		const content = clean(message.content);
		if (message.role === "system")
			return { role: "system", content, timestamp: now };
		if (message.role === "user")
			return { role: "user", content, timestamp: now };
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: content }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		};
		return assistant;
	});
	return { systemPrompt: clean(request.system + jsonRule), messages };
}

function messageText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

type Resolved = {
	model: Model<"openai-completions">;
	apiKey: string;
	cloud: boolean;
	slug: string;
};

/** LlmPort over the user's Pi model registry (OpenAI-compatible endpoints). */
export class PiLlm implements LlmPort {
	#registry = new Map<string, PiModel>();
	#fastDefault?: string;
	#streams = new Map<string, PiStreamImpl>();
	constructor(private readonly options: LlmPiOptions) {}

	/** Load the registry once so `isCloud` has data; never throws. */
	async init(): Promise<this> {
		await this.#refresh();
		return this;
	}

	/**
	 * Conservative: true when either lane resolves to a non-loopback model or
	 * to a model the registry does not know (so the privacy gate holds).
	 */
	get isCloud(): boolean {
		const value = this.options.settings.value;
		for (const lane of ["fast", "deep"] as const) {
			const slug = laneModelSlug(
				value,
				lane,
				lane === "fast"
					? (this.#fastDefault ?? this.options.modelSlug)
					: this.options.modelSlug,
			);
			if (!slug) continue;
			const entry = this.#registry.get(slug);
			if (!entry || !isLoopbackUrl(entry.baseUrl)) return true;
		}
		return false;
	}

	async #refresh(): Promise<void> {
		try {
			this.#registry = await (this.options.registry ?? loadPiRegistry)(
				this.options.home,
			);
			this.#fastDefault = undefined;
			const ranked = [...this.#registry.values()]
				.filter(
					(entry) =>
						entry.cost && Number.isFinite(entry.cost.input + entry.cost.output),
				)
				.sort(
					(a, b) =>
						(a.cost?.input ?? 0) +
							(a.cost?.output ?? 0) -
							((b.cost?.input ?? 0) + (b.cost?.output ?? 0)) ||
						a.slug.localeCompare(b.slug),
				);
			for (const entry of ranked) {
				try {
					await (this.options.credential ?? piCredential)(
						this.options.home,
						entry.provider,
					);
					this.#fastDefault = entry.slug;
					break;
				} catch {
					/* Try the next authenticated model. */
				}
			}
		} catch {
			// keep the previous registry
		}
	}

	async #resolve(lane: Lane): Promise<Resolved> {
		await this.#refresh();
		const slug = laneModelSlug(
			this.options.settings.value,
			lane,
			lane === "fast"
				? (this.#fastDefault ?? this.options.modelSlug)
				: this.options.modelSlug,
		);
		if (!slug)
			throw new TutorModelError(
				`No model configured for the ${lane} lane; pick one in Settings or start the daemon with --model.`,
			);
		const entry = this.#registry.get(slug);
		if (!entry)
			throw new TutorModelError(
				`Pi model ${slug} is unavailable; register it in ~/.pi/agent/models-store.json.`,
			);
		const apiKey = await (this.options.credential ?? piCredential)(
			this.options.home,
			entry.provider,
		);
		const model: Model<"openai-completions"> = {
			id: entry.modelId,
			name: slug,
			api: "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: entry.baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: entry.maxTokens ?? 8_192,
		};
		return { model, apiKey, cloud: !isLoopbackUrl(entry.baseUrl), slug };
	}

	#streamFor(resolved: Resolved): PiStreamImpl {
		if (this.options.streamImpl) return this.options.streamImpl;
		const cacheKey = `${resolved.slug}\n${resolved.model.baseUrl}\n${resolved.apiKey}`;
		const cached = this.#streams.get(cacheKey);
		if (cached) return cached;
		const models = createModels();
		const apiKey = resolved.apiKey;
		models.setProvider(
			createProvider({
				id: PROVIDER_ID,
				name: "Sidecar lane models",
				baseUrl: resolved.model.baseUrl,
				auth: {
					apiKey: {
						name: "Pi key",
						resolve: async () => ({
							auth: { apiKey },
							source: "~/.pi/agent/auth.json",
						}),
					},
				},
				models: [resolved.model],
				api: openAICompletionsApi(),
			}),
		);
		const impl: PiStreamImpl = (model, context, options) =>
			models.stream(model, context, {
				signal: options.signal,
				maxTokens: options.maxTokens,
			});
		this.#streams.clear();
		this.#streams.set(cacheKey, impl);
		return impl;
	}

	async *#events(
		request: LlmRequest & { json?: boolean },
	): AsyncGenerator<AssistantMessageEvent> {
		const resolved = await this.#resolve(request.lane);
		const context = buildContext(request, resolved.model, resolved.cloud);
		const maxTokens = request.maxTokens
			? Math.min(request.maxTokens, resolved.model.maxTokens)
			: undefined;
		yield* this.#streamFor(resolved)(resolved.model, context, {
			apiKey: resolved.apiKey,
			signal: request.signal,
			maxTokens,
		});
	}

	async *stream(request: LlmRequest): AsyncIterable<string> {
		for await (const event of this.#events(request)) {
			if (event.type === "text_delta" && event.delta) yield event.delta;
			else if (event.type === "error")
				throw new Error(
					event.error.errorMessage ||
						`${request.lane} lane model request ${event.reason}`,
				);
		}
	}

	async complete(request: LlmRequest & { json?: boolean }): Promise<string> {
		let text = "";
		let final: string | undefined;
		for await (const event of this.#events(request)) {
			if (event.type === "text_delta") text += event.delta;
			else if (event.type === "done") final = messageText(event.message);
			else if (event.type === "error")
				throw new Error(
					event.error.errorMessage ||
						`${request.lane} lane model request ${event.reason}`,
				);
		}
		const reply = final || text;
		return request.json ? extractJson(reply) : reply;
	}
}

export async function createPiLlm(options: LlmPiOptions): Promise<PiLlm> {
	return new PiLlm(options).init();
}
