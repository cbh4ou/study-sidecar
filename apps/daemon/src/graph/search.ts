import type { Proposition } from "../protocol.ts";

const STOPWORDS = new Set(
	"a an and are as at be by for from has have in is it its of on or that the this to was were will with what how why when which who does do".split(
		" ",
	),
);

/** Lowercase keyword tokens (2+ chars, stopwords removed). */
export function keywords(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9_]+/)
				.filter((word) => word.length >= 2 && !STOPWORDS.has(word)),
		),
	];
}

function score(node: Proposition, terms: string[], phrase: string): number {
	const name = node.name.toLowerCase();
	const aliases = (node.aliases ?? []).map((a) => a.toLowerCase());
	const statement = node.statement.toLowerCase();
	const nameWords = new Set(keywords(name));
	const aliasWords = new Set(aliases.flatMap((a) => keywords(a)));
	const statementWords = new Set(keywords(statement));
	let total = 0;
	for (const term of terms) {
		if (nameWords.has(term)) total += 3;
		else if (name.includes(term)) total += 2;
		if (aliasWords.has(term)) total += 2;
		if (statementWords.has(term)) total += 1;
	}
	if (phrase && (name.includes(phrase) || aliases.includes(phrase))) total += 5;
	return total;
}

/**
 * Simple keyword ranking over name (x3), aliases (x2) and statement (x1),
 * with a bonus for the whole query appearing in the name or as an alias.
 * Ties break newest first.
 */
export function rankNodes(
	nodes: Proposition[],
	text: string,
	limit = 10,
): Proposition[] {
	const terms = keywords(text);
	const phrase = text.trim().toLowerCase();
	if (!terms.length && !phrase) return [];
	return nodes
		.map((node) => ({ node, score: score(node, terms, phrase) }))
		.filter((entry) => entry.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || b.node.createdAt.localeCompare(a.node.createdAt),
		)
		.slice(0, Math.max(0, limit))
		.map((entry) => entry.node);
}
