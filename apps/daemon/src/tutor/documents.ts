import { defineDoc } from "@earendil-works/pi-durable";
import type { TutorDocuments } from "../protocol.ts";

export const HudStateDoc = defineDoc<TutorDocuments["hud_state"]>({
	kind: "study.hud_state",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ status: "idle", mode: "spotter", message: "" }),
});

export const MermaidCanvasDoc = defineDoc<TutorDocuments["scratchpad_diagram"]>(
	{
		kind: "study.scratchpad_diagram",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ diagram: "" }),
	},
);

export const SocraticQuizDoc = defineDoc<TutorDocuments["socratic_quiz"]>({
	kind: "study.socratic_quiz",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ question: "", options: [] }),
});

export const SteeringPromptDoc = defineDoc<TutorDocuments["steering_prompt"]>({
	kind: "study.steering_prompt",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ prompt: "" }),
});

export const ResearchScratchpadDoc = defineDoc<
	TutorDocuments["research_scratchpad"]
>({
	kind: "study.research_scratchpad",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ name: "", content: "" }),
});

export const TutorTraceDoc = defineDoc<{
	items: TutorDocuments["tutor_trace"];
}>({
	kind: "study.tutor_trace",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});
