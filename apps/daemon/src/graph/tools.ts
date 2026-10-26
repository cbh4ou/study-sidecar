import type { GraphService } from "../services.ts";
import { type ToolSpec, Type } from "../tool-spec.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Deep-lane graph tools (integrator adapts them into the tutor harness). */
export function graphTools(service: GraphService): ToolSpec[] {
	return [
		{
			name: "list_propositions",
			description:
				"List propositions in the learner's knowledge graph. With a query, returns keyword matches over name, aliases and statement; without one, the most recent. One line per proposition: id | name | statement.",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number()),
			}),
			async execute(args) {
				const query = typeof args.query === "string" ? args.query.trim() : "";
				const raw = typeof args.limit === "number" ? args.limit : DEFAULT_LIMIT;
				const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
				const nodes = query
					? await service.search(query, limit)
					: await service.recent(limit);
				if (!nodes.length)
					return query
						? `No propositions match "${query}".`
						: "The graph is empty.";
				return nodes
					.map(
						(n) => `${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`,
					)
					.join("\n");
			},
		},
	];
}
