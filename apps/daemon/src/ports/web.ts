export type WebResult = { title: string; url: string; snippet: string };
export type WebPage = { url: string; title: string; text: string };

/** Web research access (cloud). Callers redact queries first. */
export interface WebSearchPort {
	readonly configured: boolean;
	search(
		query: string,
		opts?: { limit?: number; signal?: AbortSignal },
	): Promise<WebResult[]>;
	fetch(
		url: string,
		opts?: { signal?: AbortSignal; maxChars?: number },
	): Promise<WebPage>;
}
