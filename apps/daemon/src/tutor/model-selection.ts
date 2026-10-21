import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPiRegistry, piCredential } from "./provider.ts";

export async function availableTutorModels(home: string): Promise<string[]> {
	const registry = await loadPiRegistry(home);
	const providers = new Map<string, boolean>();
	for (const model of registry.values()) {
		if (providers.has(model.provider)) continue;
		providers.set(
			model.provider,
			await piCredential(home, model.provider).then(
				() => true,
				() => false,
			),
		);
	}
	return [...registry.values()]
		.filter((model) => providers.get(model.provider))
		.map((model) => model.slug)
		.sort();
}

export async function savedTutorModel(
	home: string,
): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(
			await readFile(join(home, ".study-sidecar", "model.json"), "utf8"),
		);
		return typeof value === "object" &&
			value !== null &&
			"model" in value &&
			typeof value.model === "string"
			? value.model
			: undefined;
	} catch {
		return undefined;
	}
}

export async function saveTutorModel(
	home: string,
	model: string,
): Promise<void> {
	const directory = join(home, ".study-sidecar");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "model.json"),
		`${JSON.stringify({ model })}\n`,
		{
			mode: 0o600,
		},
	);
}

export async function selectTutorModel(
	home: string,
	preferred?: string,
): Promise<{ model: string | null; models: string[] }> {
	const models = await availableTutorModels(home);
	if (preferred && !models.includes(preferred))
		throw new Error(
			`Tutor model ${preferred} is unavailable or unauthenticated`,
		);
	const saved = await savedTutorModel(home);
	const model =
		preferred ||
		(saved && models.includes(saved) ? saved : undefined) ||
		(models.length ? models[randomInt(models.length)] : null);
	if (model && !preferred && model !== saved) await saveTutorModel(home, model);
	return { model, models };
}
