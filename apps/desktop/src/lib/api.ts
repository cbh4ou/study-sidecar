import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
	Card,
	DaemonMessage,
	GraphSnapshot,
	Lesson,
	LessonDetail,
	SessionDetail,
	SessionSummary,
	SidecarSettings,
	SourceRef,
	TelemetryEntry,
} from "./protocol";
import { daemonRequest, onDaemonMessage } from "./ws";

/**
 * Typed hooks for the daemon REST API (spec Section 6.4). Daemon events
 * only notify; these queries refetch on the matching *_changed event.
 */
export const queryKeys = {
	graph: ["api", "graph"] as const,
	lessons: ["api", "lessons"] as const,
	lesson: (id: string) => ["api", "lessons", id] as const,
	dueCards: ["api", "cards", "due"] as const,
	sessions: ["api", "sessions"] as const,
	session: (path: string) => ["api", "sessions", path] as const,
	settings: ["api", "settings"] as const,
	telemetry: ["api", "telemetry"] as const,
};

/** Run `handler` for every daemon message while mounted. */
export function useDaemonMessage(
	handler: (message: DaemonMessage) => void,
): void {
	useEffect(() => onDaemonMessage(handler), [handler]);
}

/** Invalidate REST queries when the daemon announces a change. */
export function useLiveInvalidation(): void {
	const client = useQueryClient();
	useEffect(
		() =>
			onDaemonMessage((message) => {
				switch (message.type) {
					case "graph_changed":
						void client.invalidateQueries({ queryKey: queryKeys.graph });
						break;
					case "lessons_changed":
					case "question":
						void client.invalidateQueries({ queryKey: queryKeys.lessons });
						break;
					case "cards_due":
						void client.invalidateQueries({ queryKey: queryKeys.dueCards });
						break;
					case "sessions_changed":
					case "bound_session":
						void client.invalidateQueries({ queryKey: queryKeys.sessions });
						break;
					case "turn_settled":
						void client.invalidateQueries({ queryKey: queryKeys.telemetry });
						break;
				}
			}),
		[client],
	);
}

export function useGraph() {
	return useQuery({
		queryKey: queryKeys.graph,
		queryFn: () => daemonRequest<GraphSnapshot>("/api/graph"),
	});
}

export function useDeleteNode() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			daemonRequest<{ deleted: string; chainsRemoved: string[] }>(
				`/api/graph/nodes/${encodeURIComponent(id)}`,
				{ method: "DELETE" },
			),
		onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.graph }),
	});
}

export function useLessons() {
	return useQuery({
		queryKey: queryKeys.lessons,
		queryFn: () => daemonRequest<{ lessons: Lesson[] }>("/api/lessons"),
	});
}

export function useLesson(id: string | undefined) {
	return useQuery({
		queryKey: queryKeys.lesson(id ?? ""),
		queryFn: () =>
			daemonRequest<LessonDetail>(
				`/api/lessons/${encodeURIComponent(id ?? "")}`,
			),
		enabled: Boolean(id),
	});
}

export function useCreateLesson() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			goal: string;
			title?: string;
			anchors?: SourceRef[];
			sessionPath?: string;
		}) =>
			daemonRequest<{ lesson: Lesson }>("/api/lessons", {
				method: "POST",
				body: input,
			}),
		onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.lessons }),
	});
}

export function useAddLessonSource(lessonId: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (source: SourceRef) =>
			daemonRequest<LessonDetail>(
				`/api/lessons/${encodeURIComponent(lessonId)}/sources`,
				{ method: "POST", body: { source } },
			),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: queryKeys.lesson(lessonId) }),
	});
}

export function useDueCards() {
	return useQuery({
		queryKey: queryKeys.dueCards,
		queryFn: () => daemonRequest<{ cards: Card[] }>("/api/cards/due"),
	});
}

export function useSessions() {
	return useQuery({
		queryKey: queryKeys.sessions,
		queryFn: () =>
			daemonRequest<{
				sessions: SessionSummary[];
				follow: boolean;
				bound: string | null;
				acrossSessions: Array<{ id: string; name: string; sessions: string[] }>;
			}>("/api/sessions"),
		refetchInterval: 15_000,
	});
}

export function useSessionDetail(path: string | undefined) {
	return useQuery({
		queryKey: queryKeys.session(path ?? ""),
		queryFn: () =>
			daemonRequest<SessionDetail>(
				`/api/sessions/detail?path=${encodeURIComponent(path ?? "")}`,
			),
		enabled: Boolean(path),
	});
}

export function useUpdateSource() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			path: string;
			local_only?: boolean;
			index_graph?: boolean;
		}) =>
			daemonRequest<{ ok: true }>("/api/sources", {
				method: "POST",
				body: input,
			}),
		onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
	});
}

export function useSettings() {
	return useQuery({
		queryKey: queryKeys.settings,
		queryFn: () => daemonRequest<SidecarSettings>("/api/settings"),
	});
}

export type SettingsUpdate = {
	lanes?: { fast?: string; deep?: string };
	decide?: {
		adapter?: SidecarSettings["decide"]["adapter"];
		threshold?: number;
		jevApiKey?: string;
	};
	web?: { provider?: SidecarSettings["web"]["provider"]; apiKey?: string };
	voice?: Partial<SidecarSettings["voice"]>;
	privacy?: Partial<SidecarSettings["privacy"]>;
	follow?: boolean;
};

export function useUpdateSettings() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (patch: SettingsUpdate) =>
			daemonRequest<SidecarSettings>("/api/settings", {
				method: "POST",
				body: patch,
			}),
		onSuccess: (next) => client.setQueryData(queryKeys.settings, next),
	});
}

export function useTelemetry() {
	return useQuery({
		queryKey: queryKeys.telemetry,
		queryFn: () => daemonRequest<{ turns: TelemetryEntry[] }>("/api/telemetry"),
	});
}
