/** The two answering lanes (spec Section 7). */
export type Lane = "fast" | "deep";

export type LlmMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type LlmRequest = {
	lane: Lane;
	/** Byte-stable system prefix (prompt caching). */
	system: string;
	messages: LlmMessage[];
	signal?: AbortSignal;
	/** Upper bound on output tokens; adapters may clamp. */
	maxTokens?: number;
	/** One schema-validated submit tool for structured model boundaries. */
	/** Read-only tools executed by the caller after receiving a calls envelope. */
	readTools?: Array<{
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	}>;
	submit?: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
};

/**
 * Plain model access for the lanes and the graph pipeline. The deep lane's
 * tool-using conversation stays in the pi-durable tutor harness; this port
 * covers tool-free generation and structured JSON outputs.
 */
export interface LlmPort {
	/** True when requests leave the machine (privacy gate applies). */
	readonly isCloud: boolean;
	/** Stream text chunks as they arrive. */
	stream(request: LlmRequest): AsyncIterable<string>;
	/** Whole completion. With `json: true` the reply must be one JSON value. */
	complete(request: LlmRequest & { json?: boolean }): Promise<string>;
}
