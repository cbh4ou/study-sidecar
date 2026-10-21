import { expect, test } from "bun:test";
import { initialDesktopState } from "../store";
import { enqueueQuestion, flushPendingQuestions, routeQuestion } from "./ws";

test("queues offline questions and flushes them in order", () => {
	const queued = enqueueQuestion(initialDesktopState, "First", true);
	const next = enqueueQuestion(queued, "Second", true);
	const sent: string[] = [];

	expect(
		flushPendingQuestions(next.pendingQuestions, (text) => sent.push(text)),
	).toEqual([]);
	expect(sent).toEqual(["First", "Second"]);
	expect(next.questions).toEqual(["First", "Second"]);
});

test("intercepts save intent when a draft exists", () => {
	const draft = { title: "Diagram", body: "flow" };
	let saved: typeof draft | undefined;

	expect(
		routeQuestion("Save that diagram to my notes", draft, (payload) => {
			saved = payload;
		}),
	).toBe(true);
	expect(saved).toEqual(draft);
	expect(routeQuestion("Explain that diagram", draft, () => {})).toBe(false);
});
