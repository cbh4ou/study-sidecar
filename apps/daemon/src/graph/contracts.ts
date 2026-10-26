import { z } from "zod";
import type { Chain, Proposition, SourceRef } from "../protocol.ts";

/**
 * Graph boundary schemas (spec 6.1). Every JSONL line and every model
 * submission is parsed through one of these; invalid input is dropped
 * (ledgers) or reported back to the model (submits), never guessed.
 */

const lines = z
	.tuple([z.number().int().positive(), z.number().int().positive()])
	.refine(([start, end]) => end >= start, "line range must be ordered");

export const SourceRefSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("session"),
		harness: z.string().min(1),
		sessionId: z.string().min(1),
		turnId: z.string().optional(),
		file: z.string().optional(),
		lines: lines.optional(),
	}),
	z.object({
		kind: z.literal("file"),
		path: z.string().min(1),
		lines: lines.optional(),
	}),
	z.object({
		kind: z.literal("web"),
		url: z
			.url()
			.refine(
				(url) => /^https?:\/\//i.test(url),
				"web source must use HTTP or HTTPS",
			),
		quote: z.string().max(200).optional(),
	}),
	z.object({
		kind: z.literal("pdf"),
		path: z.string().min(1),
		page: z.number().int().positive(),
		quote: z.string().max(200).optional(),
	}),
	z.object({
		kind: z.literal("lesson"),
		lessonId: z.string().min(1),
		messageId: z.string().min(1),
	}),
	z.object({
		kind: z.literal("run"),
		path: z.string().min(1),
		metric: z.string().optional(),
		step: z.number().optional(),
	}),
]);

export const PropositionSchema = z.object({
	id: z.string().startsWith("n_"),
	name: z.string().min(1).max(80),
	statement: z.string().min(1),
	aliases: z.array(z.string()).optional(),
	sources: z.array(SourceRefSchema),
	createdAt: z.iso.datetime({ offset: true }),
	birthSource: z.string().min(1),
});

export const ChainSchema = z.object({
	id: z.string().startsWith("arg_"),
	premises: z.array(z.string()).min(1),
	conclusion: z.string(),
	createdAt: z.iso.datetime({ offset: true }),
	sources: z.array(SourceRefSchema),
});

export const TombstoneSchema = z.object({
	id: z.string().min(1),
	at: z.iso.datetime({ offset: true }),
});
export const CoverageSchema = z.object({
	sourceId: z.string(),
	messageHash: z.string(),
});

export type Tombstone = z.infer<typeof TombstoneSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;

/** Extractor submit: local ids for new propositions; chain endpoints may be local or existing `n_` ids. */
export const ExtractorSubmitSchema = z.object({
	propositions: z.array(
		z.object({
			id: z.string().min(1),
			name: z.string().min(1).max(80),
			statement: z.string().min(1),
			aliases: z.array(z.string()).optional(),
		}),
	),
	chains: z.array(
		z.object({
			premises: z.array(z.string().min(1)).min(1),
			conclusion: z.string().min(1),
		}),
	),
});
export type ExtractorSubmit = z.infer<typeof ExtractorSubmitSchema>;

/** Auditor submit: identity links only (new local id is the same claim as an existing node). */
export const AuditorSubmitSchema = z.object({
	links: z.array(z.object({ newId: z.string(), existingId: z.string() })),
});
export type AuditorSubmit = z.infer<typeof AuditorSubmitSchema>;

/** zod issues as one line the model can act on. */
export function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
}

function guard<T>(schema: z.ZodType<T>): (value: unknown) => value is T {
	return (value: unknown): value is T => schema.safeParse(value).success;
}

export const isProposition = guard<Proposition>(
	PropositionSchema as z.ZodType<Proposition>,
);
export const isChain = guard<Chain>(ChainSchema as z.ZodType<Chain>);
export const isTombstone = guard<Tombstone>(TombstoneSchema);
export const isCoverage = guard<Coverage>(CoverageSchema);
export type { Chain, Proposition, SourceRef };
