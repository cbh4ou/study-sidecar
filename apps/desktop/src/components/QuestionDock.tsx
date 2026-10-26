import { useState } from "react";
import type { Question as QuestionType } from "../lib/protocol";
import { useHudMessages } from "../lib/ws";
import {
	Question,
	QuestionOption,
	QuestionOptions,
	QuestionPrompt,
} from "./ai-elements/question";
import { DictationBar } from "./DictationBar";
export function QuestionDock({ question }: { question?: QuestionType }) {
	const { send } = useHudMessages();
	const [selected, setSelected] = useState("");
	if (!question)
		return (
			<section className="question-dock">
				<p>Your next question will appear here.</p>
			</section>
		);
	return (
		<section className="question-dock" aria-label="Question dock">
			<h3>
				{question.kind === "explain_back"
					? "Explain it back"
					: question.kind === "quiz"
						? "Quick check"
						: "Your thinking"}
			</h3>
			<Question>
				<QuestionPrompt>{question.prompt}</QuestionPrompt>
				{question.kind === "quiz" && (
					<>
						<QuestionOptions>
							{question.options.map((o) => (
								<QuestionOption
									key={o.id}
									value={o.id}
									onClick={() => setSelected(o.id)}
								>
									{o.label}
								</QuestionOption>
							))}
						</QuestionOptions>
						<button
							type="button"
							disabled={!selected}
							onClick={() =>
								send({
									type: "answer",
									questionId: question.id,
									value: selected,
								})
							}
						>
							Check answer
						</button>
					</>
				)}
			</Question>
			{question.kind !== "quiz" && (
				<DictationBar
					placeholder="Share your reasoning"
					onSubmit={(value) =>
						send({ type: "answer", questionId: question.id, value })
					}
				/>
			)}
		</section>
	);
}
