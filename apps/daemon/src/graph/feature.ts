import { type DaemonContext, type Feature, json } from "../feature.ts";
import { type GraphServiceDeps, GraphServiceImpl } from "./service.ts";

const NODE_ROUTE = /^\/api\/graph\/nodes\/([^/]+)$/;

/**
 * Graph feature: registers `services.graph` and serves the derived
 * snapshot plus node deletion (tombstone + chain cascade).
 */
export function createGraphFeature(
	context: DaemonContext,
	overrides: Partial<GraphServiceDeps> = {},
): Feature & { service: GraphServiceImpl } {
	const service = new GraphServiceImpl({
		root: context.root,
		llm: context.ports.llm,
		fake: context.fake,
		activity: context.activity,
		privacy: () => context.services.privacy,
		broadcast: (message) => context.broadcast(message),
		now: () => context.ports.clock.now(),
		onError: (sourceId, error) =>
			console.warn(`[graph] extraction failed for ${sourceId}:`, error),
		...overrides,
	});
	context.services.graph = service;

	return {
		name: "graph",
		service,
		start() {
			context.services.graph = service;
		},
		async stop() {
			await service.idle();
		},
		async route(request, url, cors) {
			if (url.pathname === "/api/graph" && request.method === "GET")
				return json(await service.snapshot(), cors);
			const match = NODE_ROUTE.exec(url.pathname);
			if (match && request.method === "DELETE") {
				const id = decodeURIComponent(match[1] ?? "");
				const result = await service.delete(id);
				if (!result) return json({ error: "unknown proposition" }, cors, 404);
				return json(result, cors);
			}
			return undefined;
		},
	};
}
