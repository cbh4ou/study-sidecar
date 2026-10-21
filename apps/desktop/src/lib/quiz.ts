export type QuizOption = { id: string; label: string };
export type Quiz = {
	question: string;
	options: QuizOption[];
	correctId?: string;
};

export function selectQuizOption(
	correctId: string | undefined,
	selectedId: string,
): boolean | undefined {
	return correctId ? correctId === selectedId : undefined;
}

export function parseQuiz(answer: string): { quiz?: Quiz; text: string } {
	const match = answer.match(/<socratic_quiz>([\s\S]*?)<\/socratic_quiz>/);
	if (!match) return { text: answer };
	try {
		const raw = JSON.parse(match[1]) as {
			question?: unknown;
			options?: unknown;
			correctId?: unknown;
		};
		if (typeof raw.question !== "string" || !Array.isArray(raw.options))
			return { text: answer };
		const options = raw.options.map((option): QuizOption | undefined => {
			if (!option || typeof option !== "object") return undefined;
			const { id, label } = option as { id?: unknown; label?: unknown };
			return typeof id === "string" && typeof label === "string"
				? { id, label }
				: undefined;
		});
		if (!options.length || options.some((option) => !option))
			return { text: answer };
		return {
			quiz: {
				question: raw.question,
				options: options as QuizOption[],
				...(typeof raw.correctId === "string"
					? { correctId: raw.correctId }
					: {}),
			},
			text: answer.replace(match[0], "").trim(),
		};
	} catch {
		return { text: answer };
	}
}
