import type { LlmPort, LlmRequest } from "../ports/llm.ts";

type JsonRequest = LlmRequest & { json?: boolean };
type Responder = {
	match: (request: JsonRequest) => boolean;
	respond: (request: JsonRequest) => unknown;
};

const responders: Responder[] = [];

/**
 * Script a JSON reply for `complete({json: true})` in tests. Later
 * registrations win. Returns an unregister function.
 */
export function registerFakeJsonResponder(
	match: (request: JsonRequest) => boolean,
	respond: (request: JsonRequest) => unknown,
): () => void {
	const responder: Responder = { match, respond };
	responders.unshift(responder);
	return () => {
		const index = responders.indexOf(responder);
		if (index >= 0) responders.splice(index, 1);
	};
}

/** Remove every registered JSON responder. */
export function clearFakeJsonResponders(): void {
	responders.length = 0;
}

export const FAKE_DEEP_DIAGRAM = [
	"```mermaid",
	"sequenceDiagram",
	"    participant P as Producer",
	"    participant B as Broker",
	"    participant C as Consumer",
	"    P->>B: publish(message)",
	"    B->>C: deliver(message)",
	"    C-->>B: ack",
	"    Note over B,C: No ack before the timeout means redelivery",
	"```",
].join("\n");

function lastUser(request: LlmRequest): string {
	const text =
		[...request.messages].reverse().find((message) => message.role === "user")
			?.content ?? "";
	// Lane packets wrap the learner's words in a "## Question" section; echo
	// only that, so fake answers never repeat the whole context packet.
	const question = /(?:^|\n)## Question\n([\s\S]*?)(?=\n## |\n\n|$)/.exec(
		text,
	)?.[1];
	return (question ?? text).trim().replace(/[.?!\s]+$/, "");
}

export function fakeFastAnswer(request: LlmRequest): string {
	return `Fake answer to: ${lastUser(request).slice(0, 120)}.`;
}

export function fakeDeepAnswer(request: LlmRequest): string {
	const question = lastUser(request).slice(0, 120) || "your question";
	return `Here is the longer picture for "${question}". A consumer receives a message, does its work, then acknowledges it so the broker can drop it. If the ack does not arrive in time, the broker assumes the consumer failed and delivers the message again.\n\n${FAKE_DEEP_DIAGRAM}`;
}

function chunks(text: string, count: number): string[] {
	const words = text.split(/(?<= )/);
	const size = Math.ceil(words.length / count);
	const out: string[] = [];
	for (let i = 0; i < words.length; i += size)
		out.push(words.slice(i, i + size).join(""));
	return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

export type FakeLlmOptions = {
	/** Total simulated latency per reply (default 200 ms; tests pass 0). */
	delayMs?: number;
	isCloud?: boolean;
};

/** Deterministic LlmPort for fake mode and tests. */
export class FakeLlm implements LlmPort {
	readonly isCloud: boolean;
	readonly requests: JsonRequest[] = [];
	readonly #delayMs: number;
	constructor(options: FakeLlmOptions = {}) {
		this.#delayMs = options.delayMs ?? 200;
		this.isCloud = options.isCloud ?? false;
	}

	#text(request: LlmRequest): string {
		return request.lane === "deep"
			? fakeDeepAnswer(request)
			: fakeFastAnswer(request);
	}

	async *stream(request: LlmRequest): AsyncIterable<string> {
		this.requests.push(request);
		const parts = chunks(this.#text(request), 3);
		const step = this.#delayMs / parts.length;
		for (const part of parts) {
			await sleep(step, request.signal);
			if (request.signal?.aborted) throw new Error("aborted");
			yield part;
		}
	}

	async complete(request: JsonRequest): Promise<string> {
		this.requests.push(request);
		await sleep(this.#delayMs, request.signal);
		if (!request.json) return this.#text(request);
		const responder = responders.find((entry) => entry.match(request));
		return JSON.stringify(responder ? responder.respond(request) : {});
	}
}
