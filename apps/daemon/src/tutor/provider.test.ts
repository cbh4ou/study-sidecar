import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModes } from "../modes/modes.ts";
import { loadPiRegistry, PiAuthError, piCredential } from "./provider.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<string> {
	const home = await mkdtemp("/tmp/sidecar-provider-");
	temporary.push(home);
	await mkdir(join(home, ".pi/agent"), { recursive: true });
	await writeFile(
		join(home, ".pi/agent/models-store.json"),
		JSON.stringify({
			zai: {
				models: [
					{
						id: "glm-5.3",
						provider: "zai",
						api: "openai-completions",
						baseUrl: "https://llm.test",
						maxTokens: 900,
					},
				],
			},
		}),
	);
	return home;
}

describe("modes and Pi provider", () => {
	test("loads frontmatter and user override", async () => {
		const root = await mkdtemp("/tmp/sidecar-modes-");
		temporary.push(root);
		const user = join(root, "user");
		await mkdir(user);
		await writeFile(
			join(root, "co-pilot.md"),
			"---\ntitle: Built In\nwake_on_tools: [write, bash]\n---\nBuilt in persona",
		);
		await writeFile(
			join(user, "co-pilot.md"),
			"---\ntitle: Override\nchattiness_cooldown_sec: 9\nvoice_profile: test\n---\nOverride persona",
		);
		const modes = await loadModes(user, root);
		expect(modes.get("co-pilot")).toMatchObject({
			title: "Override",
			chattiness: { cooldown_sec: 9, max_proactive_per_10m: 3 },
			voice: { provider: "test" },
			prompt: "Override persona",
		});
	});

	test("loads the Pi registry and resolves the stored credential", async () => {
		const home = await fixture();
		const registry = await loadPiRegistry(home);
		expect(registry.get("zai/glm-5.3")).toMatchObject({
			modelId: "glm-5.3",
			baseUrl: "https://llm.test",
		});
		await writeFile(
			join(home, ".pi/agent/auth.json"),
			JSON.stringify({ zai: { key: "secret" } }),
		);
		expect(await piCredential(home, "zai")).toBe("secret");
	});

	test("reports missing Pi authentication actionably", async () => {
		const home = await fixture();
		await expect(piCredential(home, "zai")).rejects.toBeInstanceOf(PiAuthError);
	});
});
