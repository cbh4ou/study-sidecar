import { join } from "node:path";
import {
	createEmptyCard,
	type Card as FsrsCard,
	fsrs,
	type Grade,
	Rating,
} from "ts-fsrs";
import { appendJsonLine, readJsonLines } from "../paths.ts";
import type { Clock } from "../ports/clock.ts";
import type { Card, ReviewRating, SourceRef } from "../protocol.ts";

/** One line of `cards/reviews.jsonl` (spec Section 6.2). */
export type ReviewLogLine = {
	cardId: string;
	at: string;
	rating: ReviewRating;
	by: "button" | "voice" | "explain_back";
	answerText?: string;
};

export type CardState = {
	card: Card;
	due: number;
	fsrs: FsrsCard;
	reviews: number;
};

const RATINGS: Record<ReviewRating, Grade> = {
	again: Rating.Again,
	hard: Rating.Hard,
	good: Rating.Good,
	easy: Rating.Easy,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function isCard(value: unknown): value is Card {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.propositionId === "string" &&
		typeof value.question === "string" &&
		typeof value.createdAt === "string" &&
		isRecord(value.source) &&
		typeof value.source.kind === "string"
	);
}

function isReview(value: unknown): value is ReviewLogLine {
	return (
		isRecord(value) &&
		typeof value.cardId === "string" &&
		typeof value.at === "string" &&
		typeof value.rating === "string" &&
		value.rating in RATINGS &&
		(value.by === "button" ||
			value.by === "voice" ||
			value.by === "explain_back")
	);
}

const scheduler = fsrs({ enable_fuzz: false });

/**
 * Replay a card's reviews (in time order) through FSRS. A card with no
 * reviews is due at its creation time.
 */
export function replayCard(card: Card, reviews: ReviewLogLine[]): FsrsCard {
	let state = createEmptyCard(new Date(card.createdAt));
	const ordered = reviews
		.filter((review) => review.cardId === card.id)
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	for (const review of ordered) {
		state = scheduler.next(state, new Date(review.at), RATINGS[review.rating])
			.card;
	}
	return state;
}

let counter = 0;
function newCardId(now: number): string {
	counter = (counter + 1) % 1_000_000;
	return `card_${now.toString(36)}_${counter.toString(36)}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
}

/**
 * Sole writer of `cards/cards.jsonl` and `cards/reviews.jsonl`. Both are
 * append-only; FSRS state is derived on every read. Cards never write to
 * the graph.
 */
export class CardStore {
	readonly cardsPath: string;
	readonly reviewsPath: string;
	constructor(
		root: string,
		private readonly clock: Clock,
	) {
		this.cardsPath = join(root, "cards", "cards.jsonl");
		this.reviewsPath = join(root, "cards", "reviews.jsonl");
	}

	async cards(): Promise<Card[]> {
		const all = await readJsonLines(this.cardsPath, isCard);
		const byId = new Map<string, Card>();
		for (const card of all) if (!byId.has(card.id)) byId.set(card.id, card);
		return [...byId.values()];
	}

	reviews(): Promise<ReviewLogLine[]> {
		return readJsonLines(this.reviewsPath, isReview);
	}

	async get(id: string): Promise<Card | undefined> {
		return (await this.cards()).find((card) => card.id === id);
	}

	async create(input: {
		propositionId: string;
		question: string;
		example?: string;
		source: SourceRef;
	}): Promise<Card> {
		const now = this.clock.now();
		const card: Card = {
			id: newCardId(now),
			propositionId: input.propositionId,
			question: input.question,
			...(input.example ? { example: input.example } : {}),
			source: input.source,
			createdAt: new Date(now).toISOString(),
		};
		await appendJsonLine(this.cardsPath, card);
		return card;
	}

	async review(
		cardId: string,
		rating: ReviewRating,
		by: ReviewLogLine["by"],
		answerText?: string,
	): Promise<ReviewLogLine> {
		if (!(await this.get(cardId))) throw new Error(`unknown card ${cardId}`);
		const line: ReviewLogLine = {
			cardId,
			at: new Date(this.clock.now()).toISOString(),
			rating,
			by,
			...(answerText ? { answerText } : {}),
		};
		await appendJsonLine(this.reviewsPath, line);
		return line;
	}

	async states(): Promise<CardState[]> {
		const [cards, reviews] = await Promise.all([this.cards(), this.reviews()]);
		const grouped = new Map<string, ReviewLogLine[]>();
		for (const review of reviews) {
			const list = grouped.get(review.cardId) ?? [];
			list.push(review);
			grouped.set(review.cardId, list);
		}
		return cards.map((card) => {
			const own = grouped.get(card.id) ?? [];
			const state = replayCard(card, own);
			return { card, due: state.due.getTime(), fsrs: state, reviews: own.length };
		});
	}

	/** Cards due at `now` (default: clock), soonest first. */
	async due(now = this.clock.now()): Promise<Card[]> {
		return (await this.states())
			.filter((state) => state.due <= now)
			.sort((a, b) => a.due - b.due || a.card.id.localeCompare(b.card.id))
			.map((state) => state.card);
	}
}
