import { z } from "zod";
import { type Feature, json, readBody } from "../feature.ts";
import { SourceRefSchema } from "../graph/contracts.ts";
import type { SessionEvent } from "../ingest/events.ts";
import { DECIDE_OPTIONS } from "../ports/decide.ts";
import type { Card, ClientMessage } from "../protocol.ts";
import type { GraphService } from "../services.ts";
import { CreateLessonSchema } from "./contracts.ts";
import { Learn, type LearnDeps } from "./service.ts";

export const CARDS_DUE_INTERVAL_MS = 5 * 60_000;
export const RECAP_IDLE_MS = 10 * 60_000;
export const NUDGE_COOLDOWN_MS = 10 * 60_000;

const EDIT_TOOLS = new Set([
	"edit",
	"write",
	"multiedit",
	"str_replace",
	"apply_patch",
	"notebookedit",
]);

const STOPWORDS = new Set(
	"this that with from into when then than what which while where there their them they have been will would should could about after before every other some such only also each more most over under your yours the and for are was were not but can use uses used using concept".split(
		" ",
	),
);

export function keywords(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
		),
	];
}

function editText(event: SessionEvent): string | undefined {
	if (event.diff) return event.diff;
	const tool = event.tool_name?.toLowerCase();
	if (tool && EDIT_TOOLS.has(tool))
		return [event.file_path, event.details].filter(Boolean).join("\n");
	return undefined;
}

/**
 * True when the card's proposition name, or at least two statement
 * keywords, appear in the edit text.
 */
export async function cardMatchesEdit(
	card: Card,
	text: string,
	graph: GraphService | undefined,
): Promise<boolean> {
	const words = new Set(keywords(text));
	if (words.size === 0) return false;
	const node = await graph?.get(card.propositionId).catch(() => undefined);
	const name = node?.name ?? card.propositionId.replace(/^n_(concept_)?/, "");
	const nameWords = keywords(name);
	if (nameWords.length > 0 && nameWords.every((word) => words.has(word)))
		return true;
	const statementWords = keywords(
		[node?.statement, ...(node?.aliases ?? [])].filter(Boolean).join(" "),
	);
	return statementWords.filter((word) => words.has(word)).length >= 2;
}

export type LearnFeature = Feature & { readonly service: Learn };

/**
 * Classroom lessons, questions, FSRS cards, refresher prompts and recap.
 * Takes the full DaemonContext in production (it satisfies LearnDeps).
 */
export function createLearnFeature(context: LearnDeps): LearnFeature {
	const service = new Learn(context);
	context.services.learn = service;
	const clock = context.ports.clock;
	let dnd = false;
	let lastNudgeAt = Number.NEGATIVE_INFINITY;
	let dueTimer: unknown;
	let idleTimer: unknown;
	let stopped = false;

	const scheduleDue = () => {
		if (stopped) return;
		dueTimer = clock.setTimeout(() => {
			void service.broadcastDue().catch(() => undefined);
			scheduleDue();
		}, CARDS_DUE_INTERVAL_MS);
	};

	const bumpIdle = () => {
		if (stopped) return;
		if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
		idleTimer = clock.setTimeout(() => {
			idleTimer = undefined;
			void service.recap().catch(() => undefined);
		}, RECAP_IDLE_MS);
	};

	const maybeNudge = async (text: string) => {
		if (dnd || clock.now() - lastNudgeAt < NUDGE_COOLDOWN_MS) return;
		const due = await service.dueCards();
		for (const card of due) {
			if (!(await cardMatchesEdit(card, text, context.services.graph)))
				continue;
			const decision = await context.ports.decide.decide(
				"nudge_gate",
				`Due card: ${card.question}\nEdit:\n${text.slice(0, 2000)}`,
				DECIDE_OPTIONS.nudge_gate,
				{
					localOnly:
						context.services.privacy?.isLocalOnly(
							context.services.sessions?.bound()?.path,
						) ?? false,
					context: { cardId: card.id },
				},
			);
			if (decision.choice !== "nudge") return;
			if (dnd || clock.now() - lastNudgeAt < NUDGE_COOLDOWN_MS) return;
			lastNudgeAt = clock.now();
			context.broadcast({ type: "card_prompt", card });
			return;
		}
	};

	const handleMessage = async (message: ClientMessage) => {
		switch (message.type) {
			case "answer": {
				try {
					const result = await service.answer(
						message.questionId,
						message.value,
					);
					const active = service.activeLessonId();
					if (result && context.fake && active) await service.fakeTurn(active);
				} catch (error) {
					context.broadcast({
						type: "error",
						message: `Could not grade answer: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return true;
			}
			case "grade": {
				try {
					await service.grade(message.cardId, message.rating, "button");
				} catch (error) {
					context.broadcast({
						type: "error",
						message: `Could not grade card: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return true;
			}
			case "dnd":
				dnd = message.on;
				return false;
			default:
				return false;
		}
	};

	return {
		name: "learn",
		service,
		start() {
			stopped = false;
			scheduleDue();
		},
		stop() {
			stopped = true;
			if (dueTimer !== undefined) clock.clearTimeout(dueTimer);
			if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
			dueTimer = idleTimer = undefined;
		},
		onConnect(send) {
			void service
				.dueCards()
				.then((cards) => send({ type: "cards_due", count: cards.length }))
				.catch(() => undefined);
		},
		onClientMessage: handleMessage,
		onEvent(event) {
			bumpIdle();
			const text = editText(event as SessionEvent);
			if (text) void maybeNudge(text).catch(() => undefined);
		},
		async route(request, url, cors) {
			const path = url.pathname;
			const fail = (message: string, status = 400) =>
				json({ error: message }, cors, status);
			if (path === "/api/lessons") {
				if (request.method === "GET")
					return json({ lessons: await service.listLessons() }, cors);
				if (request.method === "POST") {
					const parsed = CreateLessonSchema.safeParse(await readBody(request));
					if (!parsed.success)
						return fail(parsed.error.issues[0]?.message ?? "invalid lesson");
					const { anchor, anchors, ...body } = parsed.data;
					const lesson = await service.createLesson({
						...body,
						anchors: anchors ?? (anchor ? [anchor] : []),
					});
					if (context.dispatch)
						void context
							.dispatch({
								type: "question",
								text: lesson.goal,
								lessonId: lesson.id,
							})
							.catch((error) =>
								context.broadcast({
									type: "error",
									message: `Could not start lesson: ${String(error)}`,
								}),
							);
					else if (context.fake) await service.fakeTurn(lesson.id);
					return json({ lesson }, cors);
				}
				return fail("method not allowed", 405);
			}
			if (path === "/api/cards/due") {
				if (request.method !== "GET") return fail("method not allowed", 405);
				return json({ cards: await service.dueCards() }, cors);
			}
			if (path === "/api/recap") {
				if (request.method !== "POST") return fail("method not allowed", 405);
				try {
					const cards = await service.recap();
					return json({ cards }, cors);
				} catch (error) {
					return fail(
						error instanceof Error ? error.message : "recap failed",
						500,
					);
				}
			}
			const cardMatch = /^\/api\/cards\/([^/]+)\/answer$/.exec(path);
			if (cardMatch?.[1]) {
				if (request.method !== "POST") return fail("method not allowed", 405);
				const parsed = z
					.object({ text: z.string().trim().min(1).max(16000) })
					.safeParse(await readBody(request));
				if (!parsed.success) return fail("answer text is required");
				try {
					return json(
						{
							rating: await service.gradeVoice(
								decodeURIComponent(cardMatch[1]),
								parsed.data.text,
							),
						},
						cors,
					);
				} catch (error) {
					return fail(
						error instanceof Error ? error.message : "could not grade",
						400,
					);
				}
			}
			const match = /^\/api\/lessons\/([^/]+)(\/(?:sources|active))?$/.exec(
				path,
			);
			if (!match?.[1]) return undefined;
			const id = decodeURIComponent(match[1]);
			if (!match[2]) {
				if (request.method !== "GET") return fail("method not allowed", 405);
				const detail = await service.lesson(id);
				return detail ? json(detail, cors) : fail("lesson not found", 404);
			}
			if (request.method !== "POST") return fail("method not allowed", 405);
			if (!(await service.lesson(id))) return fail("lesson not found", 404);
			if (match[2] === "/active") {
				service.setActiveLesson(id);
				const detail = await service.lesson(id);
				const question = detail?.questions.find((q) => !detail.answers[q.id]);
				if (question)
					context.broadcast({ type: "question", lessonId: id, question });
				return json({ ok: true }, cors);
			}
			const parsed = z
				.object({ source: SourceRefSchema })
				.safeParse(await readBody(request));
			if (!parsed.success) return fail("invalid source");
			try {
				return json(await service.addSource(id, parsed.data.source), cors);
			} catch (error) {
				return fail(error instanceof Error ? error.message : "bad source");
			}
		},
	};
}
