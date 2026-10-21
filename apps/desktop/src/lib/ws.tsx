import {
	type UseMutationResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useReducer } from "react";
import type { DaemonMessage, DesktopState } from "../store";
import {
	initialDesktopState,
	nextReconnectDelay,
	reduceDaemonMessage,
} from "../store";
import type { Connection } from "./connection";
import { mapStatusToConnection } from "./connection";
import { parseDaemonMessage } from "./protocol";
import { buildSavePayload, type ConceptPayload } from "./save-payload";
import { getSidecarToken } from "./token";

const daemonUrl = "http://127.0.0.1:4321";
type DaemonState = {
	watching: boolean;
	session: string | null;
	mode: string;
	model: string;
};
type SteeringResponse = { prompt: string };
type ModelsResponse = { model: string | null; models: string[] };
type VoiceEndpoint = { ws_url: string | null };
type SavedConcept = { path?: string };
export type SaveConceptMutation = UseMutationResult<
	SavedConcept,
	Error,
	ConceptPayload
>;
type HudMessages = {
	state: DesktopState;
	messages: DaemonMessage[];
	connection: Connection;
	send: (message: object) => void;
	setMode: (name: string) => void;
	save: SaveConceptMutation;
	saveDraft: ConceptPayload | null;
};

let state = initialDesktopState;
let messages: DaemonMessage[] = [];
let connection: Connection = "waiting";
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let tokenPromise: Promise<string> | undefined;
const subscribers = new Set<() => void>();

let saveDraft: ConceptPayload | null = null;
let saveDraftConcept: ((payload: ConceptPayload) => void) | undefined;

function authToken(): Promise<string> {
	if (!tokenPromise) tokenPromise = getSidecarToken().catch(() => "");
	return tokenPromise;
}

async function daemonJson<T>(path: string): Promise<T> {
	const token = await authToken();
	const response = await fetch(`${daemonUrl}${path}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	const unauthorized = mapStatusToConnection(response.status);
	if (unauthorized) {
		connection = unauthorized;
		notify();
		throw new Error(`Daemon rejected the desktop token (${response.status})`);
	}
	if (!response.ok)
		throw new Error(`Daemon request failed (${response.status})`);
	return response.json() as Promise<T>;
}

export async function fetchDaemonState(): Promise<DaemonState> {
	return daemonJson<DaemonState>("/api/state");
}

export function useDaemonState() {
	return useQuery({
		queryKey: ["daemon", "state"],
		queryFn: fetchDaemonState,
		staleTime: 5_000,
	});
}

export function useTutorModels() {
	return useQuery({
		queryKey: ["daemon", "models"],
		queryFn: () => daemonJson<ModelsResponse>("/api/models"),
	});
}

export function useSetTutorModel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (model: string) => {
			const token = await authToken();
			const response = await fetch(`${daemonUrl}/api/model`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({ model }),
			});
			if (!response.ok)
				throw new Error(`Model change failed (${response.status})`);
			return response.json() as Promise<{ model: string }>;
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["daemon", "models"] }),
				queryClient.invalidateQueries({ queryKey: ["daemon", "state"] }),
			]);
		},
	});
}

export function useLatestSteering() {
	return useQuery({
		queryKey: ["daemon", "steering"],
		queryFn: () => daemonJson<SteeringResponse>("/latest-steering"),
		staleTime: 10_000,
	});
}

export function useVoiceUrl() {
	return useQuery({
		queryKey: ["daemon", "voice"],
		queryFn: () => daemonJson<VoiceEndpoint>("/voice"),
		staleTime: 3_000,
	});
}

export async function saveConcept(
	payload: ConceptPayload,
): Promise<SavedConcept> {
	const token = await authToken();
	const response = await fetch(`${daemonUrl}/okf/save`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(payload),
	});
	const unauthorized = mapStatusToConnection(response.status);
	if (unauthorized) throw new Error("Daemon rejected the desktop token");
	if (!response.ok) throw new Error(`Save failed (${response.status})`);
	return response.json() as Promise<SavedConcept>;
}

export function useSaveConcept(): SaveConceptMutation {
	return useMutation({ mutationFn: saveConcept });
}

function notify(): void {
	for (const subscriber of subscribers) subscriber();
}

function update(next: DesktopState): void {
	state = next;
	notify();
}

export const isSaveIntent = (text: string): boolean =>
	/\bsave(?:\s+(?:this|that|it))?\s+(?:diagram|note|exchange|answer|concept)\b/i.test(
		text,
	);

export function enqueueQuestion(
	current: DesktopState,
	text: string,
	pending: boolean,
): DesktopState {
	return {
		...current,
		questions: [...current.questions, text].slice(-50),
		pendingQuestions: pending
			? [...current.pendingQuestions, text].slice(-50)
			: current.pendingQuestions,
	};
}

export function flushPendingQuestions(
	pending: string[],
	sendQuestion: (text: string) => void,
): string[] {
	for (const text of pending) sendQuestion(text);
	return [];
}

function flushPendingMessages(): void {
	if (socket?.readyState !== WebSocket.OPEN || !state.pendingQuestions.length)
		return;
	const pendingQuestions = flushPendingQuestions(
		state.pendingQuestions,
		(text) => socket?.send(JSON.stringify({ type: "question", text })),
	);
	update({ ...state, pendingQuestions });
}

export function routeQuestion(
	text: string,
	draft: ConceptPayload | null,
	save: (payload: ConceptPayload) => void,
): boolean {
	if (!draft || !isSaveIntent(text)) return false;
	save(draft);
	return true;
}

export function send(message: object): void {
	const outgoing = message as { type?: string; text?: string };
	if (
		outgoing.type === "question" &&
		typeof outgoing.text === "string" &&
		outgoing.text.trim()
	) {
		if (
			routeQuestion(outgoing.text, saveDraft, (draft) =>
				saveDraftConcept?.(draft),
			)
		)
			return;
		const open = socket?.readyState === WebSocket.OPEN;
		// Always mark pending: an open socket still awaits the tutor's reply.
		update(enqueueQuestion(state, outgoing.text, true));
		if (open) socket?.send(JSON.stringify(message));
		return;
	}
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify(message));
}

function setMode(name: string): void {
	send({ type: "set_mode", name });
}

async function connect(): Promise<void> {
	clearTimeout(reconnectTimer);
	const token = await authToken();
	const url = token
		? `ws://127.0.0.1:4321/ws?token=${encodeURIComponent(token)}`
		: "ws://127.0.0.1:4321/ws";
	const current = new WebSocket(url);
	socket?.close();
	socket = current;
	connection = reconnectAttempt ? "reconnecting" : "waiting";
	notify();
	current.onopen = () => {
		reconnectAttempt = 0;
		connection = "connected";
		flushPendingMessages();
		notify();
		void fetchDaemonState()
			.then((snapshot) =>
				update(
					reduceDaemonMessage(state, {
						type: "mode_changed",
						name: snapshot.mode,
					}),
				),
			)
			.catch(() => undefined);
	};
	current.onmessage = ({ data }) => {
		let raw: unknown;
		try {
			raw = JSON.parse(String(data));
		} catch {
			return; // a malformed daemon frame is ignored so a later valid frame can recover the HUD
		}
		const message = parseDaemonMessage(raw);
		if (!message) return;
		messages = [...messages, message].slice(-100);
		update(reduceDaemonMessage(state, message));
	};
	current.onclose = () => {
		if (socket !== current || !subscribers.size) return;
		if (connection === "unauthorized") return;
		connection = "reconnecting";
		notify();
		reconnectTimer = window.setTimeout(() => {
			reconnectAttempt += 1;
			void connect();
		}, nextReconnectDelay(reconnectAttempt));
	};
}

function disconnect(): void {
	clearTimeout(reconnectTimer);
	socket?.close();
	socket = undefined;
	connection = "waiting";
}

const HudMessagesContext = createContext<HudMessages | undefined>(undefined);

export function HudMessagesProvider({ children }: { children: ReactNode }) {
	const [, redraw] = useReducer((version: number) => version + 1, 0);
	const save = useSaveConcept();
	const draft = buildSavePayload(state.questions, state.answers, state.events);
	useEffect(() => {
		saveDraft = draft;
		saveDraftConcept = save.mutate;
		return () => {
			if (saveDraftConcept === save.mutate) saveDraftConcept = undefined;
		};
	}, [draft, save.mutate]);
	useEffect(() => {
		subscribers.add(redraw);
		if (subscribers.size === 1) void connect();
		return () => {
			subscribers.delete(redraw);
			if (!subscribers.size) disconnect();
		};
	}, []);
	const value = {
		state,
		messages,
		connection,
		send,
		setMode,
		save,
		saveDraft: draft,
	};
	return (
		<HudMessagesContext.Provider value={value}>
			{children}
		</HudMessagesContext.Provider>
	);
}

export function useHudMessages(): HudMessages {
	const value = useContext(HudMessagesContext);
	if (!value) throw new Error("HudMessagesProvider is required");
	return value;
}
