import type { SessionEvent, SessionInfo } from "../ingest/events.ts";
import { OKFStore } from "../memory/okf-store.ts";
import type { TutorMode } from "../modes/modes.ts";
import type {
	DaemonErrorScope,
	TutorDocuments,
	TutorEmit,
} from "../protocol.ts";
import { cooldownPassed, DeadAirWatch } from "../sieve/dead-air.ts";
import { detectAntipatterns } from "../sieve/tier0.ts";
import type { ToolSpec } from "../tool-spec.ts";
import {
	openTutorHarness,
	type TutorDocumentPatch,
	type TutorHarness,
} from "./harness.ts";

const PROVIDER_BACKOFF_MS = 120_000;
export type TutorMessage = TutorEmit;

/** Gate-2 classification: how loudly the tutor reacts to one session delta. */
export type DeltaClass = "SILENT" | "AMBIENT_PILL" | "PROACTIVE_COACH";

export function classifyDelta(
	event: SessionEvent,
	mode: TutorMode,
	findings: string[],
): DeltaClass {
	if (event.is_error) return "PROACTIVE_COACH";
	if (findings.length > 0) return "AMBIENT_PILL";
	const tool = event.tool_name?.toLowerCase();
	let delta: DeltaClass = "SILENT";
	if (tool && mode.wake_triggers.on_tools.includes(tool)) {
		if (
			event.event_type === "tool_call" &&
			(tool === "write" || tool === "edit")
		)
			delta =
				event.details.length > 400 || event.headline.includes(" :: ")
					? "PROACTIVE_COACH"
					: "AMBIENT_PILL";
		if (event.event_type === "tool_result" && tool === "bash") {
			const duration = event.metadata?.duration_ms;
			delta =
				typeof duration === "number" && duration > 10_000
					? "PROACTIVE_COACH"
					: "SILENT";
		} else if (event.event_type === "tool_call" && delta === "SILENT")
			delta = "AMBIENT_PILL";
	}
	if (!mode.wake_triggers.highlight_regex) return delta;
	try {
		return delta === "SILENT" &&
			new RegExp(mode.wake_triggers.highlight_regex, "i").test(
				`${event.headline}\n${event.details}`,
			)
			? "AMBIENT_PILL"
			: delta;
	} catch {
		return delta;
	}
}

function quizDocument(
	answer: string,
): TutorDocuments["socratic_quiz"] | undefined {
	const payload = answer.match(
		/<socratic_quiz>([\s\S]*?)<\/socratic_quiz>/,
	)?.[1];
	if (!payload) return undefined;
	try {
		const quiz = JSON.parse(payload) as Record<string, unknown>;
		if (typeof quiz.question !== "string" || !Array.isArray(quiz.options))
			return undefined;
		const options = quiz.options.flatMap((option) => {
			if (!option || typeof option !== "object") return [];
			const value = option as Record<string, unknown>;
			return typeof value.id === "string" && typeof value.label === "string"
				? [{ id: value.id, label: value.label }]
				: [];
		});
		if (!options.length || options.length !== quiz.options.length)
			return undefined;
		return {
			question: quiz.question,
			options,
			...(typeof quiz.correctId === "string"
				? { correctId: quiz.correctId }
				: {}),
		};
	} catch {
		return undefined;
	}
}

export class TutorEngine {
	#events: SessionEvent[] = [];
	#session?: SessionInfo;
	#lastSpoke = 0;
	#tutor?: TutorHarness;
	#opening?: Promise<TutorHarness>;
	#openedScope?: string;
	#cancelling: Promise<void> = Promise.resolve();
	#modelSlug: string;
	#lastProviderError = 0;
	#providerBackoffUntil = 0;
	#lastSteering = "";
	#proactiveAt: number[] = [];
	#deadAir: DeadAirWatch;
	hydrating = false;

	constructor(
		private mode: TutorMode,
		private readonly emit: (message: TutorMessage) => void,
		private readonly options: {
			harness?: TutorHarness;
			memory?: OKFStore;
			deadAirSeconds?: number;
			home?: string;
			modelSlug?: string;
			openHarness?: typeof openTutorHarness;
			extraTools?: () => ToolSpec[];
			allowCloud?: (path?: string) => boolean;
			sourceScope?: () => string;
		} = {},
	) {
		this.#tutor = options.harness;
		this.#modelSlug = options.modelSlug ?? "zai/glm-5.3";
		this.#deadAir = new DeadAirWatch({
			seconds: options.deadAirSeconds ?? 15,
			events: () => this.#events,
			mode: () => this.mode,
			lastSpoke: () => this.#lastSpoke,
			onDeadAir: (command) => void this.#deadAirInsight(command),
		});
	}

	setSession(session: SessionInfo): void {
		this.#session = session;
	}
	setMode(mode: TutorMode): void {
		this.mode = mode;
		this.#lastSpoke = 0;
		void this.#tutor
			?.updateDocuments({
				hud_state: { mode: mode.name, status: "idle", message: "" },
			})
			.catch(() => undefined);
	}
	reset(): void {
		this.#events = [];
		this.#session = undefined;
		this.#lastSpoke = 0;
		this.#proactiveAt = [];
		this.#deadAir.cancel();
	}
	get latestSteering(): string {
		return this.#lastSteering;
	}
	get activeMode(): TutorMode {
		return this.mode;
	}

	observe(event: SessionEvent): void {
		const preceding = this.#events.slice(-10);
		this.#events.push(event);
		if (this.#events.length > 100) this.#events.shift();
		this.#deadAir.cancel();
		if (this.hydrating || this.options.allowCloud?.() === false) return;
		const tool = event.tool_name?.toLowerCase();
		if (event.event_type === "tool_call" && tool === "bash")
			this.#deadAir.touch(event.details);
		else if (
			event.event_type === "tool_call" &&
			(tool === "write" || tool === "edit")
		)
			this.#deadAir.touch(event.file_path ?? event.headline);
		else if (
			event.event_type === "agent_message" &&
			preceding.some((previous) => previous.event_type === "tool_call")
		)
			this.#deadAir.touch(event.headline);
		const findings = detectAntipatterns(event.details);
		if (findings.length) this.emit({ type: "guardrail", findings });
		switch (classifyDelta(event, this.mode, findings)) {
			case "SILENT":
				return;
			case "AMBIENT_PILL":
				if (this.#cooldown()) void this.#insight(event, false);
				return;
			case "PROACTIVE_COACH":
				if (!this.#proactiveAvailable()) return;
				if (this.#cooldown()) {
					const claimedAt = this.#claimProactive();
					if (claimedAt !== undefined)
						void this.#insight(event, true, claimedAt);
				} else void this.#steer(event.headline);
		}
	}

	async answer(question: string): Promise<string> {
		const tutor = await this.#tutorHandle();
		await tutor.updateDocuments({
			hud_state: {
				status: "thinking",
				mode: this.mode.name,
				message: question.slice(0, 500),
			},
		});
		const answer = await this.#generate(
			`### Developer Question / Learning Query\n${question}\n\nPlease answer the question as Sidecar Tutor.`,
		);
		const mermaid = [...answer.matchAll(/```mermaid\s*\r?\n([\s\S]*?)```/gi)]
			.at(-1)?.[1]
			?.trim();
		const quiz = quizDocument(answer);
		const documents: TutorDocumentPatch = {
			hud_state: {
				status: "speaking",
				mode: this.mode.name,
				message: answer.slice(0, 1_000),
			},
			...(mermaid ? { scratchpad_diagram: { diagram: mermaid } } : {}),
			...(quiz ? { socratic_quiz: quiz } : {}),
		};
		await tutor.updateDocuments(documents);
		const voice = {
			...(this.mode.voice.language !== undefined
				? { language: this.mode.voice.language }
				: {}),
			...(this.mode.voice.speed !== undefined
				? { speed: this.mode.voice.speed }
				: {}),
			...(this.mode.voice.accent !== undefined
				? { voice: this.mode.voice.accent }
				: {}),
		};
		this.emit({
			type: "tutor_answer",
			answer,
			...(mermaid ? { mermaid } : {}),
			...(Object.keys(voice).length ? { voice } : {}),
		});
		await this.#steer(`Q: ${question}\nA: ${answer.slice(0, 600)}`);
		return answer;
	}

	interrupt(): void {
		this.#cancelling = (this.#tutor?.abort?.() ?? Promise.resolve()).catch(
			() => undefined,
		);
	}

	async close(): Promise<void> {
		await this.#opening?.catch(() => undefined);
		await this.#tutor?.close();
		this.#tutor = undefined;
	}

	async setModel(modelSlug: string): Promise<void> {
		if (modelSlug === this.#modelSlug) return;
		await this.close();
		this.#modelSlug = modelSlug;
		this.#providerBackoffUntil = 0;
	}

	#cooldown(): boolean {
		return cooldownPassed(this.mode, this.#lastSpoke);
	}

	#proactiveAvailable(now = Date.now()): boolean {
		this.#proactiveAt = this.#proactiveAt.filter(
			(timestamp) => now - timestamp < 10 * 60 * 1000,
		);
		return (
			this.mode.chattiness.max_proactive_per_10m > 0 &&
			this.#proactiveAt.length < this.mode.chattiness.max_proactive_per_10m
		);
	}

	#claimProactive(): number | undefined {
		const now = Date.now();
		if (!this.#proactiveAvailable(now)) return undefined;
		this.#proactiveAt.push(now);
		return now;
	}

	#releaseProactive(timestamp: number): void {
		const index = this.#proactiveAt.indexOf(timestamp);
		if (index >= 0) this.#proactiveAt.splice(index, 1);
	}

	#fail(scope: DaemonErrorScope, message: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.emit({
			type: "daemon_error",
			scope,
			message: `${message}: ${detail}`,
		});
		console.error(`tutor ${scope} failure: ${message}: ${detail}`);
		void this.#tutor
			?.updateDocuments({
				hud_state: { status: "error", message: detail },
			})
			.catch(() => undefined);
	}

	async #insight(
		event: SessionEvent,
		steer: boolean,
		claimedAt?: number,
	): Promise<void> {
		if (Date.now() < this.#providerBackoffUntil) {
			if (claimedAt !== undefined) this.#releaseProactive(claimedAt);
			return;
		}
		try {
			const insight = await this.#generate(
				`The agent just did: ${event.headline}. Explain why this meaningful action matters in 2 sentences.`,
			);
			this.#lastSpoke = Date.now();
			await this.#tutor?.updateDocuments({
				hud_state: {
					status: "speaking",
					mode: this.mode.name,
					message: insight,
				},
			});
			this.emit({ type: "ambient_insight", insight });
			if (steer) await this.#steer(insight);
		} catch (error) {
			if (claimedAt !== undefined) this.#releaseProactive(claimedAt);
			this.#fail("insight", "ambient insight generation failed", error);
		}
	}

	async #deadAirInsight(command: string): Promise<void> {
		const claimedAt = this.#claimProactive();
		if (claimedAt === undefined || Date.now() < this.#providerBackoffUntil) {
			if (claimedAt !== undefined) this.#releaseProactive(claimedAt);
			return;
		}
		try {
			const insight = await this.#generate(
				`The developer is waiting for \`${command}\`. In 2-3 sentences explain the recent write or edit and why it matters.`,
			);
			this.#lastSpoke = Date.now();
			await this.#tutor?.updateDocuments({
				hud_state: {
					status: "speaking",
					mode: this.mode.name,
					message: insight,
				},
			});
			this.emit({ type: "dead_air_insight", insight, command });
			await this.#steer(insight);
		} catch (error) {
			this.#releaseProactive(claimedAt);
			this.#fail("dead_air", "dead-air insight generation failed", error);
		}
	}

	async #steer(exchange: string): Promise<void> {
		if (Date.now() < this.#providerBackoffUntil) return;
		try {
			const prompt = await this.#generate(
				`### Latest Tutor Exchange\n${exchange}\n\nOutput EXACTLY one suggested steering prompt: a single imperative sentence, no preamble or quotes.`,
			);
			this.#lastSteering = prompt;
			await this.#tutor?.updateDocuments({
				steering_prompt: { prompt },
			});
			this.emit({ type: "steering_prompt", prompt });
		} catch (error) {
			this.#fail("steering", "steering prompt generation failed", error);
		}
	}

	async #generate(prompt: string): Promise<string> {
		await this.#cancelling;
		if (this.options.allowCloud?.() === false)
			throw new Error("This source is local only.");
		try {
			const answer = await (await this.#tutorHandle()).converse(prompt);
			return answer;
		} catch (error) {
			if (
				error instanceof Error &&
				/already belongs|storage error|close and reopen/i.test(error.message)
			) {
				await this.#tutor?.close().catch(() => undefined);
				this.#tutor = undefined;
			}
			this.#providerFailure(error);
			throw error;
		}
	}

	async #tutorHandle(): Promise<TutorHarness> {
		const sourceScope = this.options.sourceScope?.();
		if (this.#tutor && sourceScope !== this.#openedScope) await this.close();
		this.#openedScope = sourceScope;
		if (this.#tutor) return this.#tutor;
		this.#opening ??= (this.options.openHarness ?? openTutorHarness)({
			home: this.options.home ?? process.env.HOME ?? "",
			modelSlug: this.#modelSlug,
			memory: this.options.memory ?? new OKFStore(),
			mode: () => this.mode,
			events: () => this.#events,
			sessionCwd: () => this.#session?.cwd,
			sourceSession: () => this.#session?.id ?? "standalone",
			onDocuments: (documents) =>
				this.emit({ type: "tutor_documents", documents }),
			extraTools: this.options.extraTools,
			allowCloud: this.options.allowCloud,
			sourceScope,
		});
		try {
			this.#tutor = await this.#opening;
			return this.#tutor;
		} finally {
			this.#opening = undefined;
		}
	}

	#providerFailure(error: unknown): void {
		const now = Date.now();
		this.#providerBackoffUntil = now + PROVIDER_BACKOFF_MS;
		if (now - this.#lastProviderError < 60_000) return;
		this.#lastProviderError = now;
		const detail = error instanceof Error ? error.message : String(error);
		this.emit({
			type: "daemon_error",
			scope: "provider",
			message: `tutor provider unavailable: ${detail}`,
		});
		console.error(`tutor provider failure: ${detail}`);
		void this.#tutor
			?.updateDocuments({
				hud_state: { status: "error", message: detail },
			})
			.catch(() => undefined);
	}
}
