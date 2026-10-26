import {
	DECIDE_OPTIONS,
	type DecidePort,
	type ExplainBackVerdict,
} from "../ports/decide.ts";
import type { Question, ReviewRating } from "../protocol.ts";
import type { GraphService } from "../services.ts";

/** T8: explain-back verdict to FSRS rating. */
export function verdictToRating(verdict: ExplainBackVerdict): ReviewRating {
	switch (verdict) {
		case "correct":
			return "good";
		case "partial":
			return "hard";
		default:
			return "again";
	}
}

export function verdictPassed(verdict: ExplainBackVerdict): boolean {
	return verdict === "correct" || verdict === "partial";
}

export type GradeResult = {
	value: string;
	correct?: boolean;
	verdict?: ExplainBackVerdict;
};

/** Resolve expected proposition ids to readable statements for the judge. */
export async function expectedStatements(
	ids: string[],
	graph: GraphService | undefined,
): Promise<string[]> {
	return Promise.all(
		ids.map(async (id) => {
			const node = await graph?.get(id).catch(() => undefined);
			return node ? `${node.name}: ${node.statement}` : id;
		}),
	);
}

/**
 * Grade one answer. Quiz: exact option id match. Ask: recorded only.
 * Explain-back: closed-set DecidePort judgment over the learner's words
 * plus the expected proposition statements.
 */
export async function gradeAnswer(
	question: Question,
	value: string,
	deps: {
		decide: DecidePort;
		graph?: GraphService;
		localOnly?: boolean;
	},
): Promise<GradeResult> {
	if (question.kind === "quiz")
		return { value, correct: value.trim() === question.correctId };
	if (question.kind === "ask") return { value };
	const statements = await expectedStatements(
		question.expectedPropositions,
		deps.graph,
	);
	const input = [
		`Prompt: ${question.prompt}`,
		`Learner: ${value}`,
		"Expected:",
		...statements.map((statement) => `- ${statement}`),
	].join("\n");
	const decision = await deps.decide.decide(
		"explain_back",
		input,
		DECIDE_OPTIONS.explain_back,
		{
			localOnly: deps.localOnly,
			context: { answer: value, expected: statements },
		},
	);
	return {
		value,
		verdict: decision.choice,
		correct: verdictPassed(decision.choice),
	};
}
