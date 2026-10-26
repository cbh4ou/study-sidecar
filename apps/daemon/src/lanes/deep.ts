import type { WebSearchPort } from "../ports/web.ts";
import type {
	DaemonMessage,
	Question,
	SourceRef,
	TutorDocuments,
} from "../protocol.ts";
import type { Services } from "../services.ts";
import type { TutorEngine } from "../tutor/engine.ts";
import { redact } from "../tutor/redact.ts";
import type { ContextPacket } from "./packet.ts";

/**
 * Deep lane (spec Section 7.2): runs in parallel with the fast lane and
 * streams panel documents as `deep_update`. The real lane delegates to the
 * existing tutor engine (pi-durable harness with its tools).
 */

export type DeepRunInput = {
	question: string;
	lessonId?: string;
	packet: ContextPacket;
	signal: AbortSignal;
	turnId: string;
	needsWeb: boolean;
	/** The question's source is local_only: no cloud web search. */
	localOnly?: boolean;
};

export interface DeepLane {
	run(input: DeepRunInput): Promise<{ answer: string }>;
}

export class AbortError extends Error {
	constructor() {
		super("turn aborted");
		this.name = "AbortError";
	}
}

/** Resolve `promise`, or reject with AbortError as soon as `signal` fires. */
export function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(new AbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new AbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

type Broadcast = (message: DaemonMessage) => void;

export type HarnessDeepLaneOptions = {
	tutor: Pick<TutorEngine, "answer" | "activeMode">;
	broadcast: Broadcast;
	web?: WebSearchPort;
};

/** Delegates to `TutorEngine.answer`; mirrors its result as a deep_update. */
export class HarnessDeepLane implements DeepLane {
	constructor(private readonly options: HarnessDeepLaneOptions) {}

	async run(input: DeepRunInput): Promise<{ answer: string }> {
		const { broadcast, web, tutor } = this.options;
		let question = input.question;
		if (input.needsWeb && web?.configured && !input.localOnly) {
			const results = await abortable(
				web.search(redact(input.question), { limit: 5, signal: input.signal }),
				input.signal,
			).catch((error) => {
				if (error instanceof AbortError) throw error;
				return [];
			});
			if (results.length) {
				broadcast({
					type: "deep_update",
					turnId: input.turnId,
					documents: {
						research_scratchpad: {
							name: "Web sources",
							content: results
								.map((r) => `- [${r.title}](${r.url}): ${r.snippet}`)
								.join("\n"),
						},
					},
				});
				question = `${input.question}\n\n### Web results (cite the URL for every fact you use)\n${results
					.map((r, i) => `[${i + 1}] ${r.title} <${r.url}>\n${r.snippet}`)
					.join("\n\n")}`;
			}
		}
		const answer = await abortable(tutor.answer(question), input.signal);
		const mermaid = [...answer.matchAll(/```mermaid\s*\r?\n([\s\S]*?)```/gi)]
			.at(-1)?.[1]
			?.trim();
		const documents: Partial<TutorDocuments> = {
			hud_state: {
				status: "speaking",
				mode: tutor.activeMode.name,
				message: answer.slice(0, 1_000),
			},
			...(mermaid ? { scratchpad_diagram: { diagram: mermaid } } : {}),
		};
		broadcast({ type: "deep_update", turnId: input.turnId, documents });
		return { answer };
	}
}

export const FAKE_DIAGRAM = `sequenceDiagram
    participant P as Producer
    participant C as Channel
    participant R as Consumer
    P->>C: send(message)
    C->>R: deliver(message)
    R-->>C: ack
    C-->>P: ack received`;

export type FakeDeepLaneOptions = {
	broadcast: Broadcast;
	services: Services;
	mode?: () => string;
};

/** Fake-mode deep lane (spec Section 12): diagram, quiz, one card. */
export class FakeDeepLane implements DeepLane {
	constructor(private readonly options: FakeDeepLaneOptions) {}

	async run(input: DeepRunInput): Promise<{ answer: string }> {
		const { broadcast, services } = this.options;
		if (input.signal.aborted) throw new AbortError();
		const answer = `Fake deep answer to: ${input.question}`;
		broadcast({
			type: "deep_update",
			turnId: input.turnId,
			documents: {
				hud_state: {
					status: "speaking",
					mode: this.options.mode?.() ?? "fake",
					message: answer,
				},
				scratchpad_diagram: { diagram: FAKE_DIAGRAM },
			},
		});
		const lessonId = input.lessonId ?? services.learn?.activeLessonId();
		const question: Question = {
			kind: "quiz",
			id: `q_${input.turnId}`,
			prompt: "When does the producer learn its message was handled?",
			options: [
				{ id: "a", label: "As soon as send returns" },
				{ id: "b", label: "When the consumer's ack reaches it" },
				{ id: "c", label: "When the channel buffers the message" },
			],
			correctId: "b",
		};
		broadcast({
			type: "question",
			...(lessonId ? { lessonId } : {}),
			question,
		});
		if (input.signal.aborted) throw new AbortError();
		const learn = services.learn;
		if (learn) {
			const [proposition] =
				(await services.graph?.recent(1).catch(() => [])) ?? [];
			const source: SourceRef = lessonId
				? { kind: "lesson", lessonId, messageId: input.turnId }
				: { kind: "session", harness: "fake", sessionId: "fake" };
			await learn
				.createCard({
					propositionId: proposition?.id ?? "fake-channel-ack",
					question: "What does a channel ack tell the producer?",
					example:
						"The consumer handled the message, so the producer may move on.",
					source,
				})
				.catch(() => undefined);
		}
		return { answer };
	}
}
