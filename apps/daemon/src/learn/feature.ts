import { type Feature, json, readBody } from "../feature.ts";
import type { SessionEvent } from "../ingest/events.ts";
import { DECIDE_OPTIONS } from "../ports/decide.ts";
import type { Card, ClientMessage, SourceRef } from "../protocol.ts";
import type { GraphService } from "../services.ts";
import { MAX_ANCHORS, MAX_GOAL } from "./lessons.ts";
import { Learn, type LearnDeps, parseSourceRef } from "./service.ts";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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
					await service.answer(message.questionId, message.value);
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
					const body = await readBody(request);
					if (!isRecord(body)) return fail("expected a JSON object");
					if (typeof body.goal !== "string" || !body.goal.trim())
						return fail("goal is required");
					if (body.goal.trim().length > MAX_GOAL)
						return fail(`goal must be at most ${MAX_GOAL} characters`);
					if (body.title !== undefined && typeof body.title !== "string")
						return fail("title must be a string");
					if (
						body.sessionPath !== undefined &&
						typeof body.sessionPath !== "string"
					)
						return fail("sessionPath must be a string");
					let anchors: SourceRef[] = [];
					if (body.anchors !== undefined) {
						if (!Array.isArray(body.anchors))
							return fail("anchors must be an array");
						if (body.anchors.length > MAX_ANCHORS)
							return fail(`a lesson holds at most ${MAX_ANCHORS} anchors`);
						try {
							anchors = body.anchors.map(parseSourceRef);
						} catch (error) {
							return fail(
								error instanceof Error ? error.message : "bad anchor",
							);
						}
					}
					const lesson = await service.createLesson({
						goal: body.goal,
						title: body.title as string | undefined,
						anchors,
						sessionPath: body.sessionPath as string | undefined,
					});
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
			const match = /^\/api\/lessons\/([^/]+)(\/sources)?$/.exec(path);
			if (!match?.[1]) return undefined;
			const id = decodeURIComponent(match[1]);
			if (!match[2]) {
				if (request.method !== "GET") return fail("method not allowed", 405);
				const detail = await service.lesson(id);
				return detail ? json(detail, cors) : fail("lesson not found", 404);
			}
			if (request.method !== "POST") return fail("method not allowed", 405);
			if (!(await service.lesson(id))) return fail("lesson not found", 404);
			const body = await readBody(request);
			if (!isRecord(body)) return fail("expected a JSON object");
			try {
				return json(await service.addSource(id, body.source), cors);
			} catch (error) {
				return fail(error instanceof Error ? error.message : "bad source");
			}
		},
	};
}
