import type { WebSearchPort } from "../ports/web.ts";
import type {
	DaemonMessage,
	Question,
	SourceRef,
	TutorDocuments,
} from "../protocol.ts";
import type { Services } from "../services.ts";
import type { TutorEngine } from "../tutor/engine.ts";
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
	tutor: Pick<TutorEngine, "answer" | "activeMode"> &
		Partial<Pick<TutorEngine, "interrupt">>;
	broadcast: Broadcast;
	web?: WebSearchPort;
};

/** Delegates to `TutorEngine.answer`; mirrors its result as a deep_update. */
export class HarnessDeepLane implements DeepLane {
	constructor(private readonly options: HarnessDeepLaneOptions) {}

	async run(input: DeepRunInput): Promise<{ answer: string }> {
		const { broadcast, tutor } = this.options;
		if (input.signal.aborted) throw new AbortError();
		const question = `Lesson workflow: Measure first, always. Ask 3 to 6 prerequisite probes using ask_question, including quizzes and think-aloud. Assess the learner's latest answers before calling set_measure. Call plan_init once to author a prerequisite DAG after Measure. Then teach one concept at a time and use tagged quizzes (planNode) or explain-back checks before claiming it learned. Queue unrelated prerequisite gaps with queue_gap. Read anchored code/run/PDF/URL sources with tools and use their variable names and metrics. Every web fact needs a source citation.\n\n${input.packet.system}\n\n${input.packet.user}${input.needsWeb && !input.localOnly ? "\n\nUse web_search for cited background research. Acknowledge the job and continue teaching." : ""}`;
		const abort = () => tutor.interrupt?.();
		input.signal.addEventListener("abort", abort, { once: true });
		let answer: string;
		try {
			answer = await abortable(tutor.answer(question), input.signal);
		} finally {
			input.signal.removeEventListener("abort", abort);
		}
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
	research?: (query: string) => Promise<unknown>;
};

/** Fake-mode deep lane (spec Section 12): diagram, quiz, one card. */
export class FakeDeepLane implements DeepLane {
	constructor(private readonly options: FakeDeepLaneOptions) {}

	async run(input: DeepRunInput): Promise<{ answer: string }> {
		const { broadcast, services } = this.options;
		if (input.signal.aborted) throw new AbortError();
		if (input.needsWeb && !input.localOnly)
			await this.options.research?.(input.question);
		const answer = `A channel acknowledgement is confirmation that the consumer handled its message. The producer can move on after that confirmation. Fake question: ${input.question}`;
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
		const learning = services.learn as typeof services.learn & {
			fakeTurn?: (id: string) => Promise<Question | undefined>;
		};
		if (lessonId && learning?.fakeTurn) await learning.fakeTurn(lessonId);
		else
			broadcast({
				type: "question",
				question: {
					kind: "quiz",
					id: `q_${input.turnId}`,
					prompt: "When does the producer learn its message was handled?",
					options: [
						{ id: "a", label: "As soon as send returns" },
						{ id: "b", label: "When the consumer handles it" },
						{ id: "c", label: "When buffered" },
					],
					correctId: "b",
				},
			});
		if (input.signal.aborted) throw new AbortError();
		const learn = services.learn;
		if (learn) {
			const sourceId = lessonId ?? "fake/session.jsonl";
			services.graph?.noteProse(
				{ id: sourceId, label: "Channel acknowledgements" },
				[{ id: input.turnId, text: answer }],
				{ flush: true },
			);
			await (
				services.graph as typeof services.graph & { idle?: () => Promise<void> }
			)?.idle?.();
			const [proposition] =
				(await services.graph?.recent(1).catch(() => [])) ?? [];
			const source: SourceRef = lessonId
				? { kind: "lesson", lessonId, messageId: input.turnId }
				: { kind: "session", harness: "fake", sessionId: "fake" };
			if (proposition)
				await learn
					.createCard({
						propositionId: proposition.id,
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
