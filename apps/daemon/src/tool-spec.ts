import { Type } from "@earendil-works/pi-ai";

export { Type };

/**
 * A deep-lane tool contributed by a feature (graph, learn, web research).
 * The integrator adapts each spec into the pi-durable tutor harness with
 * `defineTool`. `execute` returns the text the model sees; throwing reports
 * a tool error the model can retry against.
 */
export type ToolSpec = {
	name: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	execute(args: Record<string, unknown>): Promise<string>;
};
