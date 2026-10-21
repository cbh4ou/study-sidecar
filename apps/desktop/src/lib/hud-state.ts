export type HudMode = "COMPACT" | "AMBIENT_PILL" | "EXPANDED_MENTOR";
export type HudState = { mode: HudMode; insight?: string };
export type HudAction =
	| { type: "ambient"; insight: string }
	| { type: "guardrail"; insight: string }
	| { type: "expand" }
	| { type: "collapse" }
	| { type: "timeout" }
	| { type: "dead_air" }
	| { type: "tutor_answer" };

export const initialHudState: HudState = { mode: "COMPACT" };

export function hudReducer(state: HudState, action: HudAction): HudState {
	switch (action.type) {
		case "ambient":
		case "guardrail":
			return { mode: "AMBIENT_PILL", insight: action.insight };
		case "expand":
		case "dead_air":
		case "tutor_answer":
			return { mode: "EXPANDED_MENTOR", insight: state.insight };
		case "collapse":
			return initialHudState;
		case "timeout":
			return state.mode === "AMBIENT_PILL" ? initialHudState : state;
	}
}
