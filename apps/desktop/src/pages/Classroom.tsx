import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { DictationBar } from "../components/DictationBar";
import { InlineChart, parseChart } from "../components/InlineChart";
import { PlanPanel } from "../components/PlanPanel";
import { QuestionDock } from "../components/QuestionDock";
import { StudyDiagram } from "../components/StudyDiagram";
import { useAddLessonSource, useGraph, useLesson } from "../lib/api";
import type { SourceRef } from "../lib/protocol";
import { daemonRequest, useHudMessages } from "../lib/ws";
import { useVoice } from "../voice/VoiceProvider";
export function sourceLabel(source: SourceRef): string {
	switch (source.kind) {
		case "web":
			return source.url;
		case "session":
			return source.file ?? source.sessionId;
		case "lesson":
			return `Lesson ${source.lessonId}`;
		case "pdf":
			return `${source.path}, page ${source.page}`;
		default:
			return source.path;
	}
}
function Prose({ text }: { text: string }) {
	const parts = text.split(/(```chart\s*\n[\s\S]*?```)/g);
	return (
		<>
			{parts.map((part) => {
				const body = part.match(/^```chart\s*\n([\s\S]*?)```$/)?.[1];
				const chart = body ? parseChart(body) : undefined;
				return chart ? (
					<InlineChart key={part} chart={chart} />
				) : (
					<Streamdown key={part} plugins={{ math, code }}>
						{part}
					</Streamdown>
				);
			})}
		</>
	);
}
export function Classroom({ lessonId }: { lessonId: string }) {
	const { data: lesson, isPending, error } = useLesson(lessonId);
	const { data: graph } = useGraph();
	const add = useAddLessonSource(lessonId);
	const { state, send } = useHudMessages();
	const { setTranscriptTarget } = useVoice();
	const [source, setSource] = useState("");
	const [kind, setKind] = useState<"web" | "pdf">("web");
	const [page, setPage] = useState(1);
	const question = lesson?.questions.find((q) => !lesson.answers[q.id]);
	useEffect(() => {
		void daemonRequest(`/api/lessons/${encodeURIComponent(lessonId)}/active`, {
			method: "POST",
			body: {},
		}).catch(() => undefined);
	}, [lessonId]);
	useEffect(() => {
		setTranscriptTarget((text) => {
			if (question)
				send({ type: "answer", questionId: question.id, value: text });
			else send({ type: "question", text, source: "ptt", lessonId });
		});
		return () => setTranscriptTarget(undefined);
	}, [question, lessonId, send, setTranscriptTarget]);
	if (isPending) return <p>Loading lesson…</p>;
	if (error) return <p role="alert">{error.message}</p>;
	if (!lesson) return null;
	const count =
		graph?.nodes.filter((n) =>
			n.sources.some((s) => s.kind === "lesson" && s.lessonId === lessonId),
		).length ?? 0;
	return (
		<section className="classroom-page">
			<header className="page-heading">
				<div>
					<h1>{lesson.title}</h1>
					<nav aria-label="Lesson phase" className="phase-breadcrumb">
						{["measure", "plan", "teach"].map((phase) => (
							<span
								key={phase}
								aria-current={phase === lesson.phase ? "step" : undefined}
							>
								{phase}
							</span>
						))}
					</nav>
				</div>
				<dl className="measure-results">
					{Object.entries(lesson.measure ?? {}).map(([name, level]) => (
						<div key={name}>
							<dt>{name}</dt>
							<dd>{level}</dd>
						</div>
					))}
				</dl>
			</header>
			<div className="classroom-columns">
				<aside className="sources-rail">
					<h2>Sources</h2>
					<ul>
						{lesson.sources.map((s) => (
							<li key={JSON.stringify(s)}>
								{s.kind === "web" ? (
									<a href={s.url} target="_blank" rel="noreferrer">
										{sourceLabel(s)}
									</a>
								) : (
									sourceLabel(s)
								)}
							</li>
						))}
					</ul>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (source.trim())
								add.mutate(
									kind === "web"
										? { kind: "web", url: source.trim() }
										: { kind: "pdf", path: source.trim(), page },
									{ onSuccess: () => setSource("") },
								);
						}}
					>
						<h3>Add PDF or URL</h3>
						<label>
							Source type
							<select
								value={kind}
								onChange={(e) => setKind(e.target.value as "web" | "pdf")}
							>
								<option value="web">URL</option>
								<option value="pdf">Local PDF</option>
							</select>
						</label>
						<label>
							{kind === "web" ? "URL" : "PDF path"}
							<input
								type={kind === "web" ? "url" : "text"}
								required
								value={source}
								onChange={(e) => setSource(e.target.value)}
							/>
						</label>
						{kind === "pdf" && (
							<label>
								Page
								<input
									type="number"
									min={1}
									value={page}
									onChange={(e) => setPage(Number(e.target.value))}
								/>
							</label>
						)}
						<button type="submit" disabled={add.isPending}>
							Add source
						</button>
						{add.error && <p role="alert">{add.error.message}</p>}
					</form>
					<h3>Research</h3>
					{state.jobs
						?.filter((j) => j.kind === "research")
						.map((j) => (
							<p key={j.id}>
								{j.label}: {j.status}
							</p>
						))}
				</aside>
				<div className="classroom-center">
					<div
						className="lesson-conversation"
						role="log"
						aria-label="Conversation"
						aria-live="polite"
					>
						{!lesson.messages.length && (
							<p>The tutor will start with a few prerequisite probes.</p>
						)}
						{lesson.messages.map((m) => (
							<article key={m.id} className={`lesson-message ${m.role}`}>
								<strong>{m.role === "tutor" ? "Tutor" : "You"}</strong>
								<Prose text={m.text} />
							</article>
						))}
						{state.documents?.scratchpad_diagram?.diagram && (
							<StudyDiagram
								diagram={state.documents.scratchpad_diagram.diagram}
							/>
						)}
					</div>
					<QuestionDock key={question?.id} question={question} />
					<DictationBar
						onSubmit={(text) => send({ type: "question", text, lessonId })}
					/>
				</div>
				<PlanPanel lesson={lesson} contributions={count} />
			</div>
		</section>
	);
}
