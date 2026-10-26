import { z } from "zod";
import type { LlmPort } from "../ports/llm.ts";
import type { LessonMessage, SourceRef } from "../protocol.ts";
import type { GraphService } from "../services.ts";

/** One `tutor_note` / noted concept line of `<root>/notes.jsonl`. */
export type ConceptNote = {
	concept: string;
	why?: string;
	source?: SourceRef;
	at: string;
};

export type RecapCandidate = {
	propositionId?: string;
	concept?: string;
	question: string;
	example?: string;
};

export const RecapSchema = z.object({
	cards: z
		.array(
			z.object({
				propositionId: z.string().min(1).optional(),
				concept: z.string().min(1).max(120).optional(),
				question: z.string().min(8).max(400),
				example: z.string().max(600).optional(),
			}),
		)
		.min(1)
		.max(8),
});

export const RECAP_SYSTEM = [
	"You write spaced-repetition recall cards for a learner at the end of a coding session.",
	'Reply with one JSON object: {"cards":[{"concept","question","example"?,"propositionId"?}]}.',
	"Write 3 to 5 cards, one concept each. A question is a recall prompt that never states its own answer.",
	"Prefer the learner's own variable names and code in `example` when the transcript provides them.",
	"Only use propositionId values that appear in the input.",
].join("\n");

export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 48) || "concept"
	);
}

export function syntheticPropositionId(concept: string): string {
	return `n_concept_${slug(concept)}`;
}

/** Fake-mode / fallback candidates straight from noted concepts. */
export function heuristicCandidates(notes: ConceptNote[]): RecapCandidate[] {
	const seen = new Set<string>();
	const out: RecapCandidate[] = [];
	for (const note of [...notes].reverse()) {
		const concept = note.concept.trim();
		const key = slug(concept);
		if (!concept || seen.has(key)) continue;
		seen.add(key);
		out.push({
			concept,
			question: note.why
				? `In your own words, what is ${concept}, and why did it matter here?`
				: `In your own words, what is ${concept}, and when would you reach for it?`,
			...(note.why ? { example: note.why } : {}),
		});
		if (out.length === 5) break;
	}
	return out;
}

export function recapPrompt(
	notes: ConceptNote[],
	tutorMessages: LessonMessage[],
): string {
	const lines = ["Noted concepts:"];
	for (const note of notes)
		lines.push(`- ${note.concept}${note.why ? ` (why: ${note.why})` : ""}`);
	if (notes.length === 0) lines.push("- (none)");
	lines.push("", "Last tutor messages:");
	for (const message of tutorMessages) lines.push(`- ${message.text}`);
	if (tutorMessages.length === 0) lines.push("- (none)");
	return lines.join("\n");
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	const body = fenced?.[1] ?? trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return JSON.parse(
		start >= 0 && end > start ? body.slice(start, end + 1) : body,
	);
}

/** Ask the deep lane for candidates; throws on invalid output. */
export async function llmCandidates(
	llm: LlmPort,
	prompt: string,
	signal?: AbortSignal,
): Promise<RecapCandidate[]> {
	const reply = await llm.complete({
		lane: "deep",
		json: true,
		system: RECAP_SYSTEM,
		messages: [{ role: "user", content: prompt }],
		signal,
		maxTokens: 1200,
	});
	return RecapSchema.parse(extractJson(reply)).cards.slice(0, 5);
}

/** Graph id when the concept is known, else a synthetic `n_concept_*` id. */
export async function resolvePropositionId(
	candidate: RecapCandidate,
	graph: GraphService | undefined,
): Promise<string> {
	if (candidate.propositionId) {
		const known = await graph
			?.get(candidate.propositionId)
			.catch(() => undefined);
		if (known) return known.id;
	}
	const concept = candidate.concept ?? candidate.question;
	const hit = await graph
		?.search(concept, 1)
		.then((found) => found[0])
		.catch(() => undefined);
	if (hit) return hit.id;
	return syntheticPropositionId(concept);
}
