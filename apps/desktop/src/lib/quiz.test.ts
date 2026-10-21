import { expect, test } from "bun:test";
import { parseQuiz, selectQuizOption } from "./quiz";

test("scores choices and extracts a socratic quiz anywhere in an answer", () => {
	expect(selectQuizOption("b", "b")).toBe(true);
	expect(selectQuizOption("b", "a")).toBe(false);
	expect(
		parseQuiz(
			'Consider this.\n<socratic_quiz>{"question":"Why?","options":[{"id":"a","label":"Because"}],"correctId":"a"}</socratic_quiz>\nExplain your choice.',
		),
	).toEqual({
		quiz: {
			question: "Why?",
			options: [{ id: "a", label: "Because" }],
			correctId: "a",
		},
		text: "Consider this.\n\nExplain your choice.",
	});
});

test("leaves malformed quiz markup visible", () => {
	const answer =
		'<socratic_quiz>{"question":"Why?","options":[{"id":"a"}]}</socratic_quiz>';
	expect(parseQuiz(answer)).toEqual({ text: answer });
});
