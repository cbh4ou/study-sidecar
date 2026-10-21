import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, Mic, MicOff } from "lucide-react";
import type { Variant } from "motion/react";
import { useEffect, useReducer, useState } from "react";
import { hudReducer, initialHudState } from "../lib/hud-state";
import { extractMermaid, nodeTargets } from "../lib/mermaid";
import type { DaemonMessage } from "../lib/protocol";
import { parseQuiz, selectQuizOption } from "../lib/quiz";
import { useDaemonState, useHudMessages, useLatestSteering } from "../lib/ws";
import { useVoice } from "../voice/VoiceProvider";
import { CodeBlock } from "./ai-elements/code-block";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "./ai-elements/conversation";
import { Message, MessageContent } from "./ai-elements/message";
import {
	Question,
	QuestionActions,
	QuestionOption,
	QuestionOptions,
	QuestionPrompt,
	QuestionSubmit,
} from "./ai-elements/question";
import { Button } from "./ui/button";
import {
	DynamicContainer,
	DynamicIsland,
	DynamicIslandProvider,
	type SizePresets,
	useDynamicIslandSize,
} from "./ui/dynamic-island";
import { MermaidView } from "./ui/mermaid-view";
import {
	MorphingDialog,
	MorphingDialogClose,
	MorphingDialogContainer,
	MorphingDialogContent,
	MorphingDialogDescription,
	MorphingDialogTitle,
	MorphingDialogTrigger,
} from "./ui/morphing-dialog";
import {
	PromptInput,
	PromptInputAction,
	PromptInputActions,
	PromptInputTextarea,
} from "./ui/prompt-input";
import { PromptSuggestion } from "./ui/prompt-suggestion";
import { Steps, StepsContent, StepsItem, StepsTrigger } from "./ui/steps";
import { TransitionPanel } from "./ui/transition-panel";

async function copyText(text: string): Promise<void> {
	if ("__TAURI__" in window) {
		try {
			await invoke("copy_text", { text });
			return;
		} catch {
			// Browser clipboard is the development fallback.
		}
	}
	await navigator.clipboard.writeText(text);
}

function eventFilePath(event: object): string | undefined {
	return "file_path" in event && typeof event.file_path === "string"
		? event.file_path
		: undefined;
}

const ISLAND_SIZE: Record<"compact" | "ambient" | "expanded", SizePresets> = {
	compact: "compactLong",
	ambient: "compactLong",
	expanded: "ultra",
};

const panelVariants = {
	enter: { opacity: 0, y: 8 },
	center: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -8 },
} satisfies { enter: Variant; center: Variant; exit: Variant };

/** Cult UI island shell: drives the official size presets from the HUD variant. */
function MentorIsland({
	variant,
	onExpand,
	children,
}: {
	variant: "compact" | "ambient" | "expanded";
	onExpand: () => void;
	children: React.ReactNode;
}) {
	const { setSize } = useDynamicIslandSize();
	useEffect(() => {
		setSize(ISLAND_SIZE[variant]);
	}, [variant, setSize]);
	return (
		<DynamicIsland
			id={variant === "expanded" ? "mentor-hud-expanded" : "mentor-hud"}
		>
			<DynamicContainer
				className={
					variant === "expanded" ? "island-expanded" : "island-collapsed"
				}
			>
				{variant === "expanded" ? (
					children
				) : (
					<button
						type="button"
						className="island-expand"
						onClick={onExpand}
						aria-label="Expand mentor"
					>
						{children}
					</button>
				)}
			</DynamicContainer>
		</DynamicIsland>
	);
}

// Module scope: remounts (Settings -> Mentor) must not replay spoken audio.
const spokenMessages = new WeakSet<object>();

export function MentorHud() {
	const { state, messages, connection, send, save, saveDraft } =
		useHudMessages();
	const { data: daemonState } = useDaemonState();
	const steering = useLatestSteering();
	const { voice, toggleListening, toggleMute, speak } = useVoice();
	const [hud, dispatch] = useReducer(hudReducer, initialHudState);
	const variant =
		hud.mode === "COMPACT"
			? "compact"
			: hud.mode === "AMBIENT_PILL"
				? "ambient"
				: "expanded";
	const latestMessage = messages.at(-1);
	const documents = state.documents;
	const latestEvent = state.events.at(-1);
	const latestAnswer = state.answers.at(-1);
	const latestMermaid =
		documents?.scratchpad_diagram.diagram ||
		extractMermaid(latestAnswer ?? "").at(-1) ||
		[...messages]
			.reverse()
			.find(
				(message): message is DaemonMessage & { type: "tutor_answer" } =>
					message.type === "tutor_answer",
			)?.mermaid;
	const prompt =
		documents?.steering_prompt.prompt ||
		state.prompts.at(-1) ||
		steering.data?.prompt;
	const lastEdit = [...state.events]
		.reverse()
		.map((event) => ({ event, filePath: eventFilePath(event) }))
		.find(
			({ event, filePath }) =>
				event.event_type === "tool_call" &&
				(Boolean(filePath) ||
					Boolean(event.diff) ||
					/^(?:Write|Edit)/.test(event.headline) ||
					event.headline.startsWith("@@")),
		);
	const handleNodeClick = (nodeId: string): void => {
		const label = nodeTargets(latestMermaid ?? "").find(
			(node) => node.id === nodeId,
		)?.label;
		if (!label) return;
		const needle = label.toLowerCase();
		// Prefer the linked diff when the node names its file or symbol.
		const editMatch = lastEdit
			? [
					lastEdit.filePath,
					lastEdit.event.headline,
					lastEdit.event.details,
				].some((text) => text?.toLowerCase().includes(needle))
			: false;
		if (editMatch) {
			const block = document.querySelector<HTMLElement>(".code-block");
			block?.scrollIntoView({ behavior: "smooth", block: "center" });
			block?.classList.add("trace-flash");
			window.setTimeout(() => block?.classList.remove("trace-flash"), 1200);
			return;
		}
		const items = [
			...document.querySelectorAll<HTMLElement>(".trace .trace-item"),
		];
		const hit = items.find((item) =>
			item.textContent?.toLowerCase().includes(needle),
		);
		const target = hit ?? document.querySelector<HTMLElement>(".trace");
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
		hit?.classList.add("trace-flash");
		window.setTimeout(() => hit?.classList.remove("trace-flash"), 1200);
	};
	const parsedQuiz = latestAnswer ? parseQuiz(latestAnswer).quiz : undefined;
	const quiz = documents?.socratic_quiz.question
		? documents.socratic_quiz
		: parsedQuiz;
	const traceItems = [
		...state.events.slice(-12).map((event) => ({
			id: event.id ?? `${event.timestamp}:${event.headline}`,
			label: event.headline,
			detail: event.details,
			status: event.is_error ? ("error" as const) : ("ok" as const),
		})),
		...(documents?.tutor_trace ?? []).map((item) => ({
			id: `tutor-${item.label}`,
			label: `Tutor · ${item.label}`,
			detail: item.detail,
			status: item.status === "running" ? ("pending" as const) : item.status,
		})),
	].slice(-20);
	const [savedPath, setSavedPath] = useState("");
	const [panel, setPanel] = useState<"chat" | "scratchpad">("chat");
	const [draft, setDraft] = useState("");
	const [quizResult, setQuizResult] = useState<{
		id: string;
		correct: boolean;
	} | null>(null);
	useEffect(() => {
		if (!savedPath) return;
		const timer = window.setTimeout(() => setSavedPath(""), 6_000);
		return () => window.clearTimeout(timer);
	}, [savedPath]);
	useEffect(() => {
		if (save.isSuccess) setSavedPath(save.data?.path ?? "Saved");
	}, [save.isSuccess, save.data]);
	useEffect(() => {
		if (!("__TAURI__" in window)) return;
		document.documentElement.classList.toggle(
			"hud-collapsed",
			variant !== "expanded",
		);
		void invoke("set_hud_variant", { variant }).catch(() => undefined);
		return () => document.documentElement.classList.remove("hud-collapsed");
	}, [variant]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: speak is unstable and adding it would replay tutor audio on every provider render; latestMessage is the sole trigger
	useEffect(() => {
		if (!latestMessage || spokenMessages.has(latestMessage)) return;
		spokenMessages.add(latestMessage);
		if (latestMessage.type === "ambient_insight" && latestMessage.insight) {
			dispatch({ type: "ambient", insight: latestMessage.insight });
			speak(latestMessage.insight);
		}
		if (latestMessage.type === "guardrail" && latestMessage.findings?.length) {
			const insight = latestMessage.findings.join(" ");
			dispatch({ type: "guardrail", insight });
			speak(insight);
		}
		if (latestMessage.type === "dead_air_insight") {
			dispatch({ type: "dead_air" });
			if (latestMessage.insight) speak(latestMessage.insight);
		}
		if (latestMessage.type === "tutor_answer" && latestMessage.answer) {
			dispatch({ type: "tutor_answer" });
			speak(latestMessage.answer, latestMessage.voice);
		}
	}, [latestMessage]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hud.insight intentionally restarts the pill timer when a fresh insight lands mid-pill
	useEffect(() => {
		if (hud.mode !== "AMBIENT_PILL") return;
		const timer = window.setTimeout(() => dispatch({ type: "timeout" }), 8_000);
		return () => window.clearTimeout(timer);
	}, [hud.mode, hud.insight]);

	useEffect(() => {
		if (!("__TAURI__" in window)) return;
		let unlisten: (() => void) | undefined;
		void listen("hud://expand", () => dispatch({ type: "expand" })).then(
			(stop) => {
				unlisten = stop;
			},
		);
		return () => unlisten?.();
	}, []);

	const submitQuestion = (): void => {
		const text = draft.trim();
		if (!text) return;
		send({ type: "question", text });
		setDraft("");
	};

	const source = state.session?.session_file?.includes("/.omp/")
		? "OMP"
		: state.session?.session_file?.includes("/.pi/")
			? "Pi"
			: state.session?.session_file?.includes("/.claude/")
				? "Claude"
				: state.session?.session_file?.includes("/.codex/")
					? "Codex"
					: state.session?.session_file?.endsWith("/state.db")
						? "Hermes"
						: "Session";
	const compactVoice =
		voice.status === "offline"
			? "Voice off"
			: voice.muted
				? "Muted"
				: voice.vad
					? "Speech"
					: voice.playback
						? "Speaking"
						: voice.listening
							? "Listening"
							: "Mic off";
	const compact = (
		<div className="compact-copy" title={latestEvent?.headline ?? connection}>
			<span className="compact-session">
				{daemonState?.watching ? "🟢" : "⚪"} {source} ·{" "}
				{state.session?.project ?? "waiting"}
			</span>
			<span className="compact-voice">{compactVoice}</span>
			{state.errors.length ? (
				<span className="hud-error-status" role="status" aria-live="polite">
					⚠ {state.errors.length} error{state.errors.length === 1 ? "" : "s"}
				</span>
			) : null}
		</div>
	);
	const ambient = (
		<p className="ambient-copy">💡 {hud.insight} — press Alt+S to explore</p>
	);
	const expanded = (
		<div className="mentor-expanded">
			{connection === "unauthorized" ? (
				<p role="alert" className="auth-error">
					Daemon rejected the desktop token — restart the desktop from the
					supervisor.
				</p>
			) : null}
			<header>
				<div>
					<strong>Mentor</strong>
					<span>
						{voice.vad
							? "Listening to speech"
							: voice.playback
								? "Tutor speaking"
								: voice.status === "offline"
									? "Voice unavailable"
									: voice.detail}
					</span>
				</div>
				<button
					type="button"
					className="text-button"
					onClick={() => dispatch({ type: "collapse" })}
				>
					Minimize
				</button>
			</header>
			{state.errors.length ? (
				<div className="hud-errors" role="status" aria-live="polite">
					<strong>Spotter errors</strong>
					<ul>
						{state.errors.map((error, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: bounded append-only error log
							<li key={`${error.scope}:${index}`}>
								{error.scope}: {error.message}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Steps defaultOpen={false} className="trace" aria-label="Recent trace">
				{traceItems.map((item) => (
					<StepsItem
						key={item.id}
						className={`trace-item ${item.status === "error" ? "error" : ""}`}
					>
						<StepsTrigger>{item.label}</StepsTrigger>
						{item.detail ? (
							<StepsContent>
								<pre>{item.detail}</pre>
							</StepsContent>
						) : null}
					</StepsItem>
				))}
			</Steps>
			{lastEdit ? (
				<CodeBlock
					code={lastEdit.event.diff ?? lastEdit.event.details}
					language="diff"
					className="code-block"
				/>
			) : null}
			<div className="study-tabs" role="tablist" aria-label="Mentor view">
				<button
					type="button"
					role="tab"
					aria-selected={panel === "chat"}
					className={panel === "chat" ? "active" : ""}
					onClick={() => setPanel("chat")}
				>
					Chat
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={panel === "scratchpad"}
					className={panel === "scratchpad" ? "active" : ""}
					onClick={() => setPanel("scratchpad")}
				>
					Scratchpad
				</button>
			</div>
			{panel === "chat" ? (
				<Conversation className="message-scroller relative">
					<ConversationContent>
						{!state.questions.length &&
							!state.answers.length &&
							!state.insights.length && (
								<p className="empty">Ask a question to start studying.</p>
							)}
						{state.questions.map((question, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: questions are an append-only log, never reordered or spliced
							<Message key={`question:${index}`} from="user">
								<MessageContent>
									{question}
									{state.pendingQuestions.includes(question)
										? "\n(sending…)"
										: ""}
								</MessageContent>
							</Message>
						))}
						{state.answers.map((answer, index) => {
							const text = parseQuiz(answer).text;
							return text ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: answers are an append-only log, never reordered or spliced
								<Message key={`${index}:${answer}`} from="assistant">
									<MessageContent>{text}</MessageContent>
								</Message>
							) : null;
						})}
						{state.insights.map((insight, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: insights are an append-only log, never reordered or spliced
							<Message key={`${insight.kind}:${index}`} from="assistant">
								<MessageContent>
									<strong>Spotter · {insight.kind.replace("_", " ")}</strong>
									{"\n"}
									{insight.text}
									{insight.command ? `\n${insight.command}` : ""}
								</MessageContent>
							</Message>
						))}
						{latestMermaid ? (
							<MermaidView
								diagram={latestMermaid}
								onNodeClick={handleNodeClick}
							/>
						) : null}
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>
			) : (
				<section className="scratchpad-panel" aria-label="Tutor scratchpad">
					{documents?.scratchpad_diagram.diagram ? (
						<MermaidView
							diagram={documents.scratchpad_diagram.diagram}
							onNodeClick={handleNodeClick}
						/>
					) : (
						<p className="empty">No active diagram.</p>
					)}
					{documents?.research_scratchpad.content ? (
						<>
							<strong>{documents.research_scratchpad.name}</strong>
							<pre>{documents.research_scratchpad.content}</pre>
						</>
					) : null}
				</section>
			)}
			{state.activeMode === "socratic" && quiz ? (
				<section className="questionnaire" aria-label="Socratic check">
					<Question
						selectionMode="single"
						onSubmit={({ selectedValues }) => {
							const id = selectedValues[0];
							if (!id) return;
							setQuizResult({
								id,
								correct: selectQuizOption(quiz.correctId, id) ?? false,
							});
						}}
					>
						<QuestionPrompt>{quiz.question}</QuestionPrompt>
						<QuestionOptions aria-label="Quiz options">
							{quiz.options.map((option) => (
								<QuestionOption key={option.id} value={option.id}>
									{option.label}
								</QuestionOption>
							))}
						</QuestionOptions>
						<QuestionActions>
							<QuestionSubmit>Answer</QuestionSubmit>
						</QuestionActions>
					</Question>
					{quizResult ? (
						<p className={quizResult.correct ? "correct" : "incorrect"}>
							{quizResult.correct ? "Correct." : "Try the trace again."}
						</p>
					) : null}
				</section>
			) : null}
			{(state.activeMode === "co-pilot" || state.activeMode === "spotter") &&
			prompt ? (
				<div className="prompt-suggestion-row">
					<PromptSuggestion
						variant="outline"
						onClick={() => void copyText(prompt)}
					>
						{prompt}
					</PromptSuggestion>
					<kbd>Alt+C</kbd>
				</div>
			) : null}
			<footer>
				<button
					type="button"
					className="save-concept"
					disabled={!saveDraft || save.isPending}
					onClick={() => saveDraft && save.mutate(saveDraft)}
				>
					[+ Save Concept to .okf]
				</button>
				{save.isError ? (
					<span role="alert" className="save-error">
						{save.error instanceof Error ? save.error.message : "Save failed"}
					</span>
				) : savedPath ? (
					<span className="save-path">{savedPath}</span>
				) : null}
				<button type="button" onClick={toggleMute}>
					{voice.muted ? "Unmute" : "Mute"}
				</button>
				<MorphingDialog>
					<MorphingDialogTrigger className="text-button">
						Shortcuts
					</MorphingDialogTrigger>
					<MorphingDialogContainer>
						<MorphingDialogContent className="morphing-dialog">
							<MorphingDialogTitle>Mentor shortcuts</MorphingDialogTitle>
							<MorphingDialogDescription>
								Alt+S expands the mentor. Alt+C copies the current steering
								prompt.
							</MorphingDialogDescription>
							<MorphingDialogClose className="top-2 right-2" />
						</MorphingDialogContent>
					</MorphingDialogContainer>
				</MorphingDialog>
			</footer>
			<PromptInput
				value={draft}
				onValueChange={setDraft}
				onSubmit={submitQuestion}
				className="prompt-input-shell"
			>
				<PromptInputTextarea
					placeholder="Ask the mentor"
					aria-label="Question for the mentor"
				/>
				<PromptInputActions>
					<span className="mode-badge">{state.activeMode || "co-pilot"}</span>
					<PromptInputAction
						tooltip={voice.listening ? "Stop microphone" : "Start microphone"}
					>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-pressed={voice.listening}
							aria-label={
								voice.listening ? "Stop microphone" : "Start microphone"
							}
							disabled={voice.status === "offline"}
							onClick={toggleListening}
						>
							{voice.listening ? <MicOff /> : <Mic />}
						</Button>
					</PromptInputAction>
					<PromptInputAction tooltip="Send">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label="Send question"
							onClick={submitQuestion}
						>
							<ArrowUp />
						</Button>
					</PromptInputAction>
				</PromptInputActions>
			</PromptInput>
		</div>
	);
	const modeIndex = ["COMPACT", "AMBIENT_PILL", "EXPANDED"].indexOf(hud.mode);
	return (
		<DynamicIslandProvider initialSize="compact">
			<MentorIsland
				variant={variant}
				onExpand={() => dispatch({ type: "expand" })}
			>
				<TransitionPanel
					className="island-panel"
					activeIndex={modeIndex < 0 ? 2 : modeIndex}
					variants={panelVariants}
					transition={{ duration: 0.25 }}
				>
					{[compact, ambient, expanded]}
				</TransitionPanel>
			</MentorIsland>
		</DynamicIslandProvider>
	);
}
