import type { ActivityHandle } from "../activity.ts";
import type { Clock } from "../ports/clock.ts";
import type { DecidePort } from "../ports/decide.ts";
import type { LlmPort } from "../ports/llm.ts";
import type {
	ClientMessage,
	DaemonMessage,
	TurnSource,
	TurnTelemetry,
} from "../protocol.ts";
import type { Services } from "../services.ts";
import { AbortError, type DeepLane } from "./deep.ts";
import { runFastLane } from "./fast.ts";
import type { BuildOptions, ContextPacket } from "./packet.ts";
import { isQuestionIntent, route } from "./router.ts";
import { localSource } from "./tools.ts";

/**
 * One push-to-talk / typed turn (spec Section 7): route, then the fast lane
 * and (in parallel) the deep lane, always ending with exactly one
 * `turn_settled` carrying telemetry.
 */

export type PacketSource = {
	build(question: string, opts?: BuildOptions): Promise<ContextPacket>;
	/** Speculative rebuild (PTT press, session events). */
	schedule(): void;
};

export type TurnDeps = {
	broadcast(message: DaemonMessage): void;
	llm: LlmPort;
	decide: DecidePort;
	deep: DeepLane;
	packets: PacketSource;
	services: Services;
	clock: Clock;
	activity?: {
		start(kind: "deep" | "research", label: string): ActivityHandle;
	};
	/** Latest steering prompt from the tutor engine ("" when none). */
	latestSteering?: () => string;
	/** Session the pill is bound to (fallback: the tailed JSONL). */
	boundSessionPath?: () => string | undefined;
	newTurnId?: () => string;
};

type QuestionMessage = Extract<ClientMessage, { type: "question" }>;

type ActiveTurn = {
	turnId: string;
	controller: AbortController;
	telemetry: TurnTelemetry;
	settled: boolean;
};

const STEERING_ASK =
	"Write one short paragraph the learner can paste into their coding agent to steer it, based on the conversation above. Imperative voice, no preamble, no quotes, no code fences.";

let turnCounter = 0;
const defaultTurnId = () =>
	`turn_${Date.now().toString(36)}_${(++turnCounter).toString(36)}`;

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export class TurnRunner {
	#current?: ActiveTurn;
	#pttStoppedAt?: number;
	constructor(private readonly deps: TurnDeps) {}

	get currentTurnId(): string | undefined {
		return this.#current?.settled ? undefined : this.#current?.turnId;
	}

	pttStart(): void {
		this.interrupt();
		this.#pttStoppedAt = undefined;
		this.deps.packets.schedule();
	}

	pttStop(): void {
		this.#pttStoppedAt = this.deps.clock.now();
	}

	/** Abort the in-flight fast+deep turn and settle it now. */
	interrupt(): void {
		const turn = this.#current;
		if (!turn || turn.settled) return;
		turn.controller.abort();
		this.#settle(turn);
	}

	async question(input: QuestionMessage): Promise<void> {
		const { deps } = this;
		const source: TurnSource = input.source ?? "typed";
		const turn: ActiveTurn = {
			turnId: (deps.newTurnId ?? defaultTurnId)(),
			controller: new AbortController(),
			telemetry: { packet_tokens: 0 },
			settled: false,
		};
		const stt =
			input.sttMs ??
			(source === "ptt" && this.#pttStoppedAt !== undefined
				? deps.clock.now() - this.#pttStoppedAt
				: undefined);
		this.#pttStoppedAt = undefined;
		if (stt !== undefined) turn.telemetry.stt_ms = stt;
		this.interrupt();
		this.#current = turn;
		const lessonId = input.lessonId ?? deps.services.learn?.activeLessonId();
		deps.broadcast({
			type: "turn_started",
			turnId: turn.turnId,
			source,
			...(lessonId ? { lessonId } : {}),
		});
		deps.broadcast({
			type: "transcript",
			turnId: turn.turnId,
			text: input.text,
			final: true,
		});
		const boundPath =
			deps.services.sessions?.bound()?.path ?? deps.boundSessionPath?.();
		try {
			const lesson = lessonId
				? await deps.services.learn?.lesson(lessonId)
				: undefined;
			const localOnly = !!(
				deps.services.privacy?.isLocalOnly(boundPath) ||
				deps.services.privacy?.isLocalOnly(lessonId) ||
				[...(lesson?.anchors ?? []), ...(lesson?.sources ?? [])].some(
					(source) => localSource(source, { services: deps.services }),
				)
			);
			const routed = await route(input.text, deps.decide, {
				localOnly,
				now: () => deps.clock.now(),
			});
			if (turn.controller.signal.aborted) return;
			turn.telemetry.decide_ms = routed.decideMs;
			turn.telemetry.decide_adapter = routed.adapter;
			if (routed.intent === "cancel") {
				this.interrupt();
				return;
			}
			if (routed.intent === "think_aloud") {
				if (lessonId)
					await deps.services.learn?.appendMessage(lessonId, {
						role: "learner",
						kind: "think_aloud",
						text: input.text,
					});
				deps.broadcast({
					type: "fast_answer",
					turnId: turn.turnId,
					text: "Noted.",
					speak: false,
				});
				return;
			}

			const excludeSession = localOnly && deps.llm.isCloud;
			if (excludeSession) {
				deps.broadcast({
					type: "error",
					message:
						"This source is local-only. Choose a local model in Settings to ask about it.",
				});
				return;
			}
			if (routed.intent === "bridge_back") {
				await this.#bridgeBack(turn, input.text, { lessonId, excludeSession });
				return;
			}
			if (!isQuestionIntent(routed.intent)) return;
			await this.#answer(turn, input.text, {
				lessonId,
				allSessions: routed.intent === "question_all_sessions",
				excludeSession,
				deep: routed.lane !== "fast_only",
				needsWeb: routed.lane === "needs_web",
				localOnly,
				label: boundPath,
			});
		} catch (error) {
			if (!(error instanceof AbortError) && !turn.controller.signal.aborted)
				deps.broadcast({
					type: "daemon_error",
					scope: "provider",
					message: `your question could not be answered: ${message(error)}`,
				});
		} finally {
			this.#settle(turn);
		}
	}

	async #bridgeBack(
		turn: ActiveTurn,
		text: string,
		opts: BuildOptions,
	): Promise<void> {
		const { deps } = this;
		let prompt = deps.latestSteering?.().trim() ?? "";
		if (!prompt) {
			const packet = await deps.packets.build(text, opts);
			turn.telemetry.packet_tokens = packet.tokens;
			const started = deps.clock.now();
			prompt = (
				await deps.llm.complete({
					lane: "fast",
					system: packet.system,
					messages: [
						{ role: "user", content: `${packet.user}\n\n${STEERING_ASK}` },
					],
					signal: turn.controller.signal,
					maxTokens: 220,
				})
			)
				.replace(/```[\s\S]*?```/g, "")
				.trim();
			turn.telemetry.fast_ttft_ms = deps.clock.now() - started;
		}
		if (turn.controller.signal.aborted) return;
		if (!prompt) throw new Error("no steering prompt available yet");
		deps.broadcast({ type: "steering_prompt", prompt });
		deps.broadcast({
			type: "fast_answer",
			turnId: turn.turnId,
			text: "Steering prompt is ready to paste.",
		});
	}

	async #answer(
		turn: ActiveTurn,
		text: string,
		opts: BuildOptions & {
			deep: boolean;
			needsWeb: boolean;
			localOnly: boolean;
			label?: string;
		},
	): Promise<void> {
		const { deps } = this;
		const { lessonId } = opts;
		const signal = turn.controller.signal;
		const learn = deps.services.learn;
		const append = (role: "tutor" | "learner", body: string) =>
			lessonId && body
				? learn
						?.appendMessage(lessonId, { role, kind: "text", text: body })
						.catch(() => undefined)
				: undefined;
		await append("learner", text);
		const packet = await deps.packets.build(text, opts);
		turn.telemetry.packet_tokens = packet.tokens;
		if (signal.aborted) return;

		const fast = runFastLane({
			llm: deps.llm,
			packet,
			signal,
			clock: deps.clock,
			onSentence: (sentence) => {
				if (!signal.aborted)
					deps.broadcast({
						type: "fast_answer",
						turnId: turn.turnId,
						text: sentence,
					});
			},
		}).then(
			async (result) => {
				if (result.ttftMs !== undefined)
					turn.telemetry.fast_ttft_ms = result.ttftMs;
				if (!result.aborted) await append("tutor", result.text);
			},
			(error) => {
				if (!signal.aborted)
					deps.broadcast({
						type: "daemon_error",
						scope: "provider",
						message: `fast lane failed: ${message(error)}`,
					});
			},
		);

		const deep = opts.deep ? this.#deep(turn, text, packet, opts) : undefined;
		await Promise.all([fast, deep]);
	}

	async #deep(
		turn: ActiveTurn,
		text: string,
		packet: ContextPacket,
		opts: {
			lessonId?: string;
			needsWeb: boolean;
			localOnly: boolean;
			label?: string;
		},
	): Promise<void> {
		const { deps } = this;
		const job = deps.activity?.start(
			opts.needsWeb ? "research" : "deep",
			text.slice(0, 80),
		);
		const signal = job
			? AbortSignal.any([turn.controller.signal, job.signal])
			: turn.controller.signal;
		const started = deps.clock.now();
		try {
			const { answer } = await deps.deep.run({
				question: text,
				...(opts.lessonId ? { lessonId: opts.lessonId } : {}),
				packet,
				signal,
				turnId: turn.turnId,
				needsWeb: opts.needsWeb,
				localOnly: opts.localOnly,
			});
			turn.telemetry.deep_total_ms = deps.clock.now() - started;
			job?.finish(signal.aborted ? "error" : "done");
			if (signal.aborted || !answer.trim()) return;
			if (opts.lessonId)
				await deps.services.learn
					?.appendMessage(opts.lessonId, {
						role: "tutor",
						kind: "text",
						text: answer,
					})
					.catch(() => undefined);
			const sourceId = opts.lessonId ?? opts.label;
			if (sourceId)
				deps.services.graph?.noteProse(
					{
						id: sourceId,
						label: opts.lessonId ? `Lesson ${opts.lessonId}` : sourceId,
						localOnly: opts.localOnly,
					},
					[{ id: turn.turnId, text: answer }],
				);
		} catch (error) {
			job?.finish("error");
			if (error instanceof AbortError || signal.aborted) return;
			deps.broadcast({
				type: "daemon_error",
				scope: "provider",
				message: `deep lane failed: ${message(error)}`,
			});
		}
	}

	#settle(turn: ActiveTurn): void {
		if (turn.settled) return;
		turn.settled = true;
		const telemetry = { ...turn.telemetry };
		this.deps.broadcast({
			type: "turn_settled",
			turnId: turn.turnId,
			telemetry,
		});
		try {
			this.deps.services.telemetry?.record(turn.turnId, telemetry);
		} catch {
			/* telemetry never breaks a turn */
		}
	}
}
