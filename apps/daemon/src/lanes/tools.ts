import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import type { DaemonContext } from "../feature.ts";
import type { Proposition, SourceRef } from "../protocol.ts";
import { type ToolSpec, Type } from "../tool-spec.ts";
import { redact } from "../tutor/redact.ts";

const Query = z.object({ query: z.string().trim().min(1).max(4000) });
const Url = z.object({ url: z.url() });
const Run = z.object({
	path: z.string().min(1),
	metric: z.string().min(1),
	every_n: z.number().int().positive().default(1),
});
const Paper = z.object({
	path: z.string().min(1),
	page: z.number().int().positive().default(1),
	pages: z.number().int().min(1).max(20).default(3),
});
export function runMetrics(
	text: string,
	metric: string,
	everyN = 1,
): Array<{ step: number; value: number }> {
	const lines = text.split(/\r?\n/).filter(Boolean),
		header = lines[0]?.split(",").map((v) => v.trim());
	const rows: Array<{ step: number; value: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(lines[i] ?? "");
		} catch {
			if (!header || i === 0) continue;
			record = Object.fromEntries(
				(lines[i] ?? "").split(",").map((v, j) => [header[j] ?? "", v.trim()]),
			);
		}
		const value = Number(record[metric]),
			step = Number(record.step ?? i);
		if (
			record[metric] !== undefined &&
			Number.isFinite(value) &&
			Number.isFinite(step)
		)
			rows.push({ step, value });
	}
	const stride = Math.max(everyN, Math.ceil(rows.length / 200));
	return rows.filter((_, i) => i % stride === 0).slice(0, 200);
}
export function localSource(
	ref: SourceRef,
	context: Pick<DaemonContext, "services">,
): boolean {
	const path =
		ref.kind === "session"
			? (ref.file ?? ref.sessionId)
			: ref.kind === "lesson"
				? ref.lessonId
				: ref.kind === "web"
					? ref.url
					: ref.path;
	return context.services.privacy?.isLocalOnly(path) ?? false;
}
export function visiblePropositions(
	nodes: Proposition[],
	context: DaemonContext,
): Proposition[] {
	return nodes.filter(
		(n) =>
			!context.ports.llm.isCloud ||
			!(
				context.services.privacy?.isLocalOnly(n.birthSource) ||
				n.sources.some((s) => localSource(s, context))
			),
	);
}
export function createDeepTools(context: DaemonContext): ToolSpec[] {
	const localOnly = () =>
		context.services.privacy?.isLocalOnly(
			context.services.sessions?.bound()?.path ?? context.watchedPath(),
		) ?? false;
	const checkFile = async (path: string) => {
		const actual = await realpath(path);
		if (
			context.ports.llm.isCloud &&
			context.services.privacy?.isLocalOnly(actual)
		)
			throw new Error("This source is local only.");
		return actual;
	};
	const background = (
		label: string,
		work: (
			signal: AbortSignal,
		) => Promise<{ text: string; sources: SourceRef[] }>,
	): string => {
		if (localOnly())
			throw new Error("Research is unavailable for a local-only source.");
		const lessonId = context.services.learn?.activeLessonId(),
			job = context.activity.start("research", label);
		const deferred = async () => {
			if (context.fake)
				await new Promise<void>((resolve, reject) => {
					const timer = context.ports.clock.setTimeout(resolve, 400);
					job.signal.addEventListener(
						"abort",
						() => {
							context.ports.clock.clearTimeout(timer);
							reject(new Error("Research stopped"));
						},
						{ once: true },
					);
				});
			if (job.signal.aborted) throw new Error("Research stopped");
			return work(job.signal);
		};
		void deferred()
			.then(async ({ text, sources }) => {
				if (job.signal.aborted) return;
				if (lessonId) {
					await context.services.learn?.appendMessage(lessonId, {
						role: "tutor",
						kind: "text",
						text,
					});
					const learn = context.services
						.learn as typeof context.services.learn & {
						addSource?: (id: string, source: SourceRef) => Promise<unknown>;
					};
					for (const source of sources)
						await learn?.addSource?.(lessonId, source);
				}
				context.broadcast({
					type: "deep_update",
					turnId: job.id,
					documents: { research_scratchpad: { name: label, content: text } },
				});
				job.finish();
			})
			.catch((error: unknown) => {
				job.finish("error");
				if (!job.signal.aborted)
					context.broadcast({
						type: "error",
						message: `Research failed: ${error instanceof Error ? error.message : String(error)}`,
					});
			});
		return JSON.stringify({ status: "queued", jobId: job.id });
	};
	return [
		{
			name: "web_search",
			description:
				"Start cited web research in the background. Returns a job acknowledgement immediately; results arrive in Sources and the lesson.",
			parameters: Type.Object({ query: Type.String() }),
			async execute(args) {
				const { query } = Query.parse(args);
				return background(`Research: ${query.slice(0, 80)}`, async (signal) => {
					const hits = await context.ports.web.search(redact(query), {
						limit: 3,
						signal,
					});
					return {
						text: hits
							.map((h) => `[${h.title}](${h.url})\n${h.snippet}`)
							.join("\n\n"),
						sources: hits.map((h) => ({
							kind: "web",
							url: h.url,
							quote: h.snippet.slice(0, 200),
						})),
					};
				});
			},
		},
		{
			name: "web_fetch",
			description:
				"Fetch a cited web page in the background. Returns a job acknowledgement immediately.",
			parameters: Type.Object({ url: Type.String() }),
			async execute(args) {
				const { url } = Url.parse(args);
				return background("Read web page", async (signal) => {
					const page = await context.ports.web.fetch(redact(url), {
						signal,
						maxChars: 12000,
					});
					return {
						text: `[${page.title}](${page.url})\n\n${page.text}`,
						sources: [
							{ kind: "web", url: page.url, quote: page.text.slice(0, 200) },
						],
					};
				});
			},
		},
		{
			name: "list_propositions",
			description:
				"Find known public propositions by keyword or list recent claims.",
			parameters: Type.Object({ query: Type.Optional(Type.String()) }),
			async execute(args) {
				const { query } = z
					.object({ query: z.string().optional() })
					.parse(args);
				const nodes = query
					? await context.services.graph?.search(query, 20)
					: await context.services.graph?.recent(20);
				return redact(
					JSON.stringify(visiblePropositions(nodes ?? [], context)),
				);
			},
		},
		{
			name: "search_across_sessions",
			description: "Search read-only receipts across non-local-only sessions.",
			parameters: Type.Object({ query: Type.String() }),
			async execute(args) {
				return redact(
					JSON.stringify(
						context.services.sessions?.searchAcross(
							Query.parse(args).query,
							12,
						) ?? [],
					),
				);
			},
		},
		{
			name: "read_run_metrics",
			description:
				'Read a numeric metric from JSONL or CSV, downsampled to 200 points. To show an inline chart, include a chart code fence containing JSON {"title":"Metric","points":[{"step":1,"value":0.5}]}.',
			parameters: Type.Object({
				path: Type.String(),
				metric: Type.String(),
				every_n: Type.Optional(Type.Number()),
			}),
			async execute(args) {
				const input = Run.parse(args);
				const path = await checkFile(input.path);
				return JSON.stringify(
					runMetrics(
						redact(await readFile(path, "utf8")),
						input.metric,
						input.every_n,
					),
				);
			},
		},
		{
			name: "read_paper",
			description:
				"Read PDF pages in the background and summarize with page references. Requires local pdftotext. Returns an acknowledgement immediately.",
			parameters: Type.Object({
				path: Type.String(),
				page: Type.Optional(Type.Number()),
				pages: Type.Optional(Type.Number()),
			}),
			async execute(args) {
				const input = Paper.parse(args);
				return background("Read paper", async (signal) => {
					let text: string;
					if (context.fake)
						text = "Fake paper: acknowledgements confirm completed handling.";
					else {
						const path = await checkFile(input.path),
							command = Bun.which("pdftotext");
						if (!command)
							throw new Error(
								"Install poppler-utils to read PDFs (pdftotext).",
							);
						const proc = Bun.spawn(
							[
								command,
								"-f",
								String(input.page),
								"-l",
								String(input.page + input.pages - 1),
								path,
								"-",
							],
							{ stdout: "pipe", stderr: "pipe", signal },
						);
						text = await new Response(proc.stdout).text();
						if ((await proc.exited) !== 0)
							throw new Error(await new Response(proc.stderr).text());
					}
					const summary = await context.ports.llm.complete({
						lane: "deep",
						system:
							"Summarize this paper section. Cite page numbers for every claim. Use no uncited facts.",
						messages: [
							{
								role: "user",
								content: redact(
									`Pages ${input.page}-${input.page + input.pages - 1}\n${text.slice(0, 40000)}`,
								),
							},
						],
						signal,
						maxTokens: 1200,
					});
					return {
						text: `${input.path}, page ${input.page}\n\n${summary}`,
						sources: [
							{
								kind: "pdf",
								path: input.path,
								page: input.page,
								quote: text.slice(0, 200),
							},
						],
					};
				});
			},
		},
	];
}
