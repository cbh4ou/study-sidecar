import { z } from "zod";
import { type DaemonContext, type Feature, json, readBody } from "./feature.ts";
import type { SettingsPatch } from "./settings.ts";

const secret = z.string().max(500);
const model = z.string().max(200);

/** POST /api/settings body: a SettingsPatch plus write-only secrets. */
export const SettingsPatchSchema = z
	.object({
		hotkeys: z
			.partialRecord(
				z.enum(["ptt", "expand", "open", "copy", "dnd", "pin"]),
				z.string().min(1).max(80),
			)
			.optional(),
		lanes: z
			.object({ fast: model.optional(), deep: model.optional() })
			.strict()
			.optional(),
		decide: z
			.object({
				adapter: z.enum(["auto", "jev", "llm", "rules"]).optional(),
				threshold: z.number().min(0).max(1).optional(),
				jevApiKey: secret.optional(),
				jevUrl: z.string().url().max(500).optional(),
			})
			.strict()
			.optional(),
		web: z
			.object({
				provider: z.enum(["none", "brave", "tavily"]).optional(),
				apiKey: secret.optional(),
			})
			.strict()
			.optional(),
		voice: z
			.object({
				mode: z.enum(["ptt", "vad"]).optional(),
				stt: model.optional(),
				tts: model.optional(),
			})
			.strict()
			.optional(),
		privacy: z
			.object({ defaultLocalOnly: z.boolean().optional() })
			.strict()
			.optional(),
		follow: z.boolean().optional(),
	})
	.strict();

/** Drop undefined leaves so a partial patch never clears stored values. */
function compact(patch: z.infer<typeof SettingsPatchSchema>): SettingsPatch {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (typeof value === "object" && value !== null) {
			const inner = Object.fromEntries(
				Object.entries(value).filter(([, leaf]) => leaf !== undefined),
			);
			// An empty secret string clears that secret.
			for (const field of ["jevApiKey", "apiKey"])
				if (inner[field] === "") inner[field] = undefined;
			out[key] = inner;
		} else out[key] = value;
	}
	return out as SettingsPatch;
}

/** GET/POST /api/settings; responses are always the public (secret-free) view. */
export function createSettingsFeature(context: DaemonContext): Feature {
	return {
		name: "settings",
		async route(request, url, cors) {
			if (url.pathname !== "/api/settings") return undefined;
			if (request.method === "GET")
				return json(context.settings.public(), cors);
			if (request.method !== "POST")
				return json({ error: "method not allowed" }, cors, 405);
			const parsed = SettingsPatchSchema.safeParse(await readBody(request));
			if (!parsed.success)
				return json(
					{
						error: "invalid settings patch",
						issues: parsed.error.issues.map((issue) => ({
							path: issue.path.join("."),
							message: issue.message,
						})),
					},
					cors,
					400,
				);
			await context.settings.update(compact(parsed.data));
			return json(context.settings.public(), cors);
		},
	};
}
