import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class TutorModelError extends Error {}
export class PiAuthError extends TutorModelError {}
export type PiModel = {
	slug: string;
	modelId: string;
	provider: string;
	baseUrl: string;
	maxTokens?: number;
	cost?: { input: number; output: number };
};

function expired(value: unknown): boolean {
	const milliseconds =
		typeof value === "number"
			? value > 10_000_000_000
				? value
				: value * 1000
			: Date.parse(String(value));
	return Number.isFinite(milliseconds) && milliseconds < Date.now();
}

export async function loadPiRegistry(
	home = process.env.HOME ?? "",
): Promise<Map<string, PiModel>> {
	let store: unknown;
	try {
		store = JSON.parse(
			await readFile(join(home, ".pi/agent/models-store.json"), "utf8"),
		);
	} catch {
		return new Map();
	}
	const models = new Map<string, PiModel>();
	for (const entry of Object.values(store as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		for (const model of ((entry as { models?: unknown }).models as
			| unknown[]
			| undefined) ?? []) {
			if (!model || typeof model !== "object") continue;
			const data = model as Record<string, unknown>;
			if (
				data.api !== "openai-completions" ||
				typeof data.id !== "string" ||
				typeof data.provider !== "string" ||
				typeof data.baseUrl !== "string"
			)
				continue;
			const slug = `${data.provider}/${data.id}`;
			models.set(slug, {
				slug,
				modelId: data.id,
				provider: data.provider,
				baseUrl: data.baseUrl,
				cost:
					data.cost &&
					typeof data.cost === "object" &&
					"input" in data.cost &&
					"output" in data.cost &&
					typeof data.cost.input === "number" &&
					typeof data.cost.output === "number"
						? { input: data.cost.input, output: data.cost.output }
						: undefined,
				maxTokens:
					typeof data.maxTokens === "number" ? data.maxTokens : undefined,
			});
		}
	}
	return models;
}

export async function piCredential(
	home: string,
	provider: string,
): Promise<string> {
	let auth: unknown;
	try {
		auth = JSON.parse(
			await readFile(join(home, ".pi/agent/auth.json"), "utf8"),
		);
	} catch {
		throw new PiAuthError(
			`No Pi authentication for ${provider}; authenticate via pi.`,
		);
	}
	const entry = (auth as Record<string, unknown>)[provider];
	if (!entry || typeof entry !== "object")
		throw new PiAuthError(
			`No Pi authentication for ${provider}; authenticate via pi.`,
		);
	const values = entry as Record<string, unknown>;
	if (expired(values.expires))
		throw new PiAuthError(
			`Pi authentication for ${provider} expired; re-authenticate via pi.`,
		);
	const credential = values.key ?? values.access;
	if (typeof credential !== "string" || !credential)
		throw new PiAuthError(
			`No Pi authentication for ${provider}; authenticate via pi.`,
		);
	return credential;
}
