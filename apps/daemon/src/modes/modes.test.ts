import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModeFile, parseFrontmatter } from "./modes.ts";

test("frontmatter only consumes its first delimiter pair", () => {
	const [fields, body] = parseFrontmatter(
		"---\ntitle: Card\n---\n# Card\n\nKept body.\n\n---\n\nAlso kept.",
	);
	expect(fields.title).toBe("Card");
	expect(body).toBe("# Card\n\nKept body.\n\n---\n\nAlso kept.");
});

test("loads nested modes and flat user modes", async () => {
	const root = await mkdtemp("/tmp/sidecar-modes-");
	try {
		const nested = join(root, "nested.md");
		const flat = join(root, "flat.md");
		await writeFile(
			nested,
			"---\nchattiness:\n  cooldown_sec: 12\n  max_proactive_per_10m: 7\nwake_triggers:\n  on_tools: [Write, bash]\n  on_dead_air_ms: 3000\n  highlight_regex: TODO\nvoice:\n  provider: kokoro\n  language: en\n  accent: UK\n  speed: 1.2\n---\nNested",
		);
		await writeFile(
			flat,
			"---\nchattiness_cooldown_sec: 9\nwake_on_tools: [edit]\nvoice_profile: legacy\nlanguage: fr\n---\nFlat",
		);
		expect(await loadModeFile(nested)).toMatchObject({
			chattiness: { cooldown_sec: 12, max_proactive_per_10m: 7 },
			wake_triggers: {
				on_tools: ["write", "bash"],
				on_dead_air_ms: 3000,
				highlight_regex: "TODO",
			},
			voice: { provider: "kokoro", language: "en", accent: "UK", speed: 1.2 },
		});
		expect(await loadModeFile(flat)).toMatchObject({
			chattiness: { cooldown_sec: 9, max_proactive_per_10m: 3 },
			wake_triggers: { on_tools: ["edit"], on_dead_air_ms: 0 },
			voice: { provider: "legacy", language: "fr" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
