import type {
	Card,
	GraphSnapshot,
	LessonDetail,
	Proposition,
	ReviewRating,
	SourceRef,
	TurnTelemetry,
} from "./protocol.ts";

/**
 * Cross-feature service contracts. Each is implemented by exactly one
 * feature and registered on `DaemonContext.services`; consumers must
 * tolerate a missing service (feature disabled or not yet started).
 */

/** Implemented by the graph feature (graph/). */
export interface GraphService {
	flush?(): Promise<void>;
	idle?(): Promise<void>;
	snapshot(): Promise<GraphSnapshot>;
	/** Keyword/FTS search over name, aliases, statement. */
	search(text: string, limit?: number): Promise<Proposition[]>;
	/** Most recently created propositions. */
	recent(limit?: number): Promise<Proposition[]>;
	get(id: string): Promise<Proposition | undefined>;
	/**
	 * Offer tutor prose for extraction. The graph feature tracks coverage and
	 * runs the pipeline when the uncovered budget is reached or `flush` is set.
	 * `sourceId` is a lessonId or a session path; never called for local_only
	 * sources when the extractor is a cloud model.
	 */
	noteProse(
		source: {
			id: string;
			label: string;
			localOnly?: boolean;
			refs?: SourceRef[];
		},
		messages: Array<{ id: string; text: string }>,
		opts?: { flush?: boolean },
	): void;
}

/** Implemented by the learn feature (learn/). */
export interface LearnService {
	fakeTurn?(
		lessonId: string,
	): Promise<import("./protocol.ts").Question | undefined>;
	/** The lesson the learner is currently in (Classroom open or last used). */
	activeLessonId(): string | undefined;
	setActiveLesson(id: string | undefined): void;
	lesson(id: string): Promise<LessonDetail | undefined>;
	/** Append a learner/tutor message to a lesson transcript. */
	appendMessage(
		lessonId: string,
		message: {
			role: "tutor" | "learner";
			kind: "text" | "think_aloud";
			text: string;
		},
	): Promise<void>;
	dueCards(now?: number): Promise<Card[]>;
	createCard(input: {
		propositionId: string;
		question: string;
		example?: string;
		source: SourceRef;
	}): Promise<Card>;
	grade(
		cardId: string,
		rating: ReviewRating,
		by: "button" | "voice" | "explain_back",
		answerText?: string,
	): Promise<void>;
	/** Free-text answer to an open Question; returns the verdict when graded. */
	answer(
		questionId: string,
		value: string,
	): Promise<{ correct?: boolean; verdict?: string } | undefined>;
	/** Queue a concept the agent flagged (MCP tutor_note) for recap. */
	noteConcept(input: {
		concept: string;
		why?: string;
		source?: SourceRef;
	}): Promise<void>;
}

/** Implemented by the privacy feature (privacy/sources.ts). */
export interface PrivacyGate {
	/** True when this source (session path, file, lesson anchor) is local_only. */
	isLocalOnly(sourcePath?: string): boolean;
	/** Whether a cloud adapter may receive text derived from this source. */
	allowCloud(sourcePath?: string): boolean;
	/** The existing tutor/redact.ts redaction, applied to every cloud-bound string. */
	redact(text: string): string;
	indexIntoGraph(sourcePath?: string): boolean;
}

export type BoundSession = {
	path: string;
	harness?: string;
	sessionId?: string;
	project?: string;
	follow: boolean;
};

/** Implemented by the sessions feature. */
export interface SessionsService {
	bound(): BoundSession | undefined;
	/** Recent Tier-0 receipts for a session (bound one by default). */
	receipts(path?: string, limit?: number): string[];
	/** Search receipts across all non-local_only watched sessions. */
	searchAcross(
		text: string,
		limit?: number,
	): Array<{ path: string; receipt: string }>;
}

/** Telemetry ring buffer (telemetry.ts). */
export interface TelemetryRecorder {
	record(turnId: string, telemetry: TurnTelemetry): void;
	recent(limit?: number): Array<TurnTelemetry & { turnId: string; at: number }>;
}

export type Services = {
	graph?: GraphService;
	learn?: LearnService;
	privacy?: PrivacyGate;
	sessions?: SessionsService;
	telemetry?: TelemetryRecorder;
};
