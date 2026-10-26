import type { Clock } from "../ports/clock.ts";
import { systemClock } from "../ports/clock.ts";
import type { LlmPort } from "../ports/llm.ts";
import type { ContextPacket } from "./packet.ts";

/**
 * Fast lane (spec Section 7.1): tool-free, packet-only, at most 2 spoken
 * sentences with no code, markdown, or lists.
 */

export const MAX_SENTENCES = 2;
export const CODE_REPLACEMENT = "I put the details in the panel.";

export const FAST_RULES =
	"Answer aloud in at most two short sentences. Plain speech only: no code, no markdown, no lists. If the answer needs code or a diagram, say it is in the panel.";

export type FastLaneInput = {
	llm: LlmPort;
	packet: Pick<ContextPacket, "system" | "user">;
	signal?: AbortSignal;
	onSentence?: (sentence: string) => void;
	clock?: Clock;
	maxTokens?: number;
};

export type FastLaneResult = {
	text: string;
	sentences: string[];
	ttftMs?: number;
	aborted: boolean;
};

const CODE_SIGNAL =
	/```|^\s{4,}\S|[{};]\s*$|\b(def|function|const|let|var|import|return|class)\s+[\w$]+\s*[(=:{]|=>|\w+\([^)]*\)\s*[{;]/m;

/** Make one sentence speakable, or swap it for the panel pointer. */
export function speakable(sentence: string): string {
	if (CODE_SIGNAL.test(sentence)) return CODE_REPLACEMENT;
	return sentence
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s*#{1,6}\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
		.replace(/[*_~|`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Pull complete sentences off the front of `buffer`. A sentence ends at
 * `.`, `!`, or `?` followed by whitespace, or at a blank line / list break.
 */
export function takeSentences(buffer: string): {
	sentences: string[];
	rest: string;
} {
	const sentences: string[] = [];
	let rest = buffer;
	for (;;) {
		const fence = rest.indexOf("```");
		const match =
			/([.!?])(["')\]]*)\s+|\n\s*\n|\n(?=\s*([-*+]|\d+[.)])\s)/.exec(rest);
		if (!match) break;
		// Never split inside an open code fence: wait for it to close.
		if (fence >= 0 && fence < match.index) {
			const close = rest.indexOf("```", fence + 3);
			if (close < 0) break;
			const end = close + 3;
			sentences.push(rest.slice(0, end));
			rest = rest.slice(end);
			continue;
		}
		const end = match.index + match[0].length;
		sentences.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	return { sentences, rest };
}

export async function runFastLane(
	input: FastLaneInput,
): Promise<FastLaneResult> {
	const clock = input.clock ?? systemClock;
	const started = clock.now();
	const spoken: string[] = [];
	let ttftMs: number | undefined;
	let buffer = "";
	let aborted = false;

	const emit = (raw: string): boolean => {
		if (spoken.length >= MAX_SENTENCES) return false;
		const sentence = speakable(raw);
		if (!sentence) return true;
		// Collapse repeated panel pointers into one.
		if (sentence === CODE_REPLACEMENT && spoken.includes(CODE_REPLACEMENT))
			return true;
		spoken.push(sentence);
		input.onSentence?.(sentence);
		return spoken.length < MAX_SENTENCES;
	};

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) controller.abort();
	try {
		const stream = input.llm.stream({
			lane: "fast",
			system: input.packet.system,
			messages: [
				{ role: "user", content: `${input.packet.user}\n\n${FAST_RULES}` },
			],
			signal: controller.signal,
			maxTokens: input.maxTokens ?? 160,
		});
		let more = true;
		for await (const chunk of stream) {
			if (input.signal?.aborted) {
				aborted = true;
				break;
			}
			if (ttftMs === undefined && chunk) ttftMs = clock.now() - started;
			buffer += chunk;
			const { sentences, rest } = takeSentences(buffer);
			buffer = rest;
			for (const sentence of sentences) {
				more = emit(sentence);
				if (!more) break;
			}
			if (!more) {
				// Enough spoken: stop the model early.
				controller.abort();
				break;
			}
		}
		if (more && !aborted && buffer.trim()) emit(buffer);
	} catch (error) {
		if (input.signal?.aborted) aborted = true;
		else if (!controller.signal.aborted) throw error;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
	}
	return {
		text: spoken.join(" "),
		sentences: spoken,
		...(ttftMs !== undefined ? { ttftMs } : {}),
		aborted: aborted || Boolean(input.signal?.aborted),
	};
}
