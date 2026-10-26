import { z } from "zod";
import type { WebPage, WebResult, WebSearchPort } from "../ports/web.ts";
import type { StoredSettings } from "../settings.ts";
import { redact } from "../tutor/redact.ts";
import type { FetchImpl } from "./decide-jev.ts";

export const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
export const TAVILY_URL = "https://api.tavily.com/search";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 20_000;

const BraveResponse = z.object({
	web: z
		.object({
			results: z
				.array(
					z.object({
						title: z.string().default(""),
						url: z.string(),
						description: z.string().default(""),
					}),
				)
				.default([]),
		})
		.optional(),
});

const TavilyResponse = z.object({
	results: z
		.array(
			z.object({
				title: z.string().default(""),
				url: z.string(),
				content: z.string().default(""),
			}),
		)
		.default([]),
});

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(whole, code: string) => {
			if (code[0] === "#") {
				const value =
					code[1]?.toLowerCase() === "x"
						? Number.parseInt(code.slice(2), 16)
						: Number.parseInt(code.slice(1), 10);
				return Number.isFinite(value) && value > 0 && value < 0x110000
					? String.fromCodePoint(value)
					: whole;
			}
			return ENTITIES[code.toLowerCase()] ?? whole;
		},
	);
}

const stripTags = (html: string) =>
	decodeEntities(html.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();

/** HTML to readable text: drops script/style/nav and friends, collapses whitespace. */
export function htmlToText(html: string): { title: string; text: string } {
	const title = stripTags(
		html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
	);
	const body = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(
			/<(script|style|noscript|nav|header|footer|aside|svg|template|iframe|form|head)\b[\s\S]*?<\/\1\s*>/gi,
			" ",
		)
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n");
	const text = decodeEntities(body.replace(/<[^>]*>/g, " "))
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
	return { title, text };
}

async function readCapped(response: Response, cap: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = cap - total;
		if (value.byteLength >= room) {
			parts.push(value.subarray(0, room));
			total = cap;
			await reader.cancel();
			break;
		}
		parts.push(value);
		total += value.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type WebProviderOptions = {
	settings: { readonly value: StoredSettings };
	fetchImpl?: FetchImpl;
	timeoutMs?: number;
};

/** Brave or Tavily search plus a capped readable-text page fetch. */
export class WebProvider implements WebSearchPort {
	constructor(private readonly options: WebProviderOptions) {}

	get configured(): boolean {
		const web = this.options.settings.value.web;
		return web.provider !== "none" && Boolean(web.apiKey);
	}

	get #fetch(): FetchImpl {
		return this.options.fetchImpl ?? fetch;
	}

	async search(
		query: string,
		opts: { limit?: number; signal?: AbortSignal } = {},
	): Promise<WebResult[]> {
		const { provider, apiKey } = this.options.settings.value.web;
		if (provider === "none" || !apiKey)
			throw new Error("web search is not configured; add a key in Settings.");
		const q = redact(query).slice(0, 400);
		const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
		const signal = withTimeout(
			opts.signal,
			this.options.timeoutMs ?? TIMEOUT_MS,
		);
		if (provider === "brave") {
			const url = new URL(BRAVE_URL);
			url.searchParams.set("q", q);
			url.searchParams.set("count", String(limit));
			const response = await this.#fetch(url.toString(), {
				method: "GET",
				headers: {
					Accept: "application/json",
					"X-Subscription-Token": apiKey,
				},
				signal,
			});
			if (!response.ok)
				throw new Error(`brave search failed: HTTP ${response.status}`);
			const data = BraveResponse.parse(await response.json());
			return (data.web?.results ?? []).slice(0, limit).map((result) => ({
				title: stripTags(result.title),
				url: result.url,
				snippet: stripTags(result.description),
			}));
		}
		const response = await this.#fetch(TAVILY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: apiKey, query: q, max_results: limit }),
			signal,
		});
		if (!response.ok)
			throw new Error(`tavily search failed: HTTP ${response.status}`);
		const data = TavilyResponse.parse(await response.json());
		return data.results.slice(0, limit).map((result) => ({
			title: result.title,
			url: result.url,
			snippet: result.content.slice(0, 500),
		}));
	}

	async fetch(
		url: string,
		opts: { signal?: AbortSignal; maxChars?: number } = {},
	): Promise<WebPage> {
		let parsed: URL;
		try {
			parsed = new URL(redact(url));
		} catch {
			throw new Error(`invalid URL: ${url}`);
		}
		if (parsed.protocol !== "https:")
			throw new Error("only https URLs can be fetched");
		const response = await this.#fetch(parsed.toString(), {
			method: "GET",
			headers: { Accept: "text/html, text/plain;q=0.9, */*;q=0.5" },
			redirect: "follow",
			signal: withTimeout(opts.signal, this.options.timeoutMs ?? TIMEOUT_MS),
		});
		if (!response.ok)
			throw new Error(`fetch ${parsed.host} failed: HTTP ${response.status}`);
		const finalUrl = response.url || parsed.toString();
		if (!finalUrl.startsWith("https:"))
			throw new Error("redirected to a non-https URL");
		const raw = await readCapped(response, MAX_BYTES);
		const type = response.headers.get("content-type") ?? "";
		const isHtml = /html|xml/i.test(type) || /^\s*</.test(raw);
		const { title, text } = isHtml
			? htmlToText(raw)
			: { title: "", text: raw.replace(/[ \t]+/g, " ").trim() };
		return {
			url: finalUrl,
			title: title || parsed.host,
			text: text.slice(0, opts.maxChars ?? DEFAULT_MAX_CHARS),
		};
	}
}
