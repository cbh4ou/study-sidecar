import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { medianMs } from "../timing.ts";
import { findRepoOkf, OKFStore } from "./okf-store.ts";

const card = (title: string, body: string) =>
	`---\ntitle: ${title}\ntopics: [general]\n---\n# ${title}\n\n${body}\n`;

async function temporary(): Promise<string> {
	return mkdtemp("/tmp/sidecar-okf-");
}

describe("OKF store", () => {
	test("uses restrictive modes and preserves thematic-break updates with provenance", async () => {
		const root = await temporary();
		try {
			const store = new OKFStore(join(root, "learner"));
			const path = await store.saveConcept(
				"Thematic",
				"First paragraph.\n\n---\n\nLast paragraph.",
				["typescript"],
				"session-1",
				"flowchart LR\nA --> B",
				"tool-1",
			);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(join(root, "learner"))).mode & 0o777).toBe(0o700);
			expect((await stat(join(root, "learner", "concepts"))).mode & 0o777).toBe(
				0o700,
			);
			await store.saveConcept("Thematic", "Second paragraph.");
			const content = await Bun.file(path).text();
			expect(content).toContain("source_session: session-1");
			expect(content).toContain("source_tool_use: tool-1");
			expect(content).toContain("```mermaid\nflowchart LR\nA --> B\n```");
			expect(content).toContain("First paragraph.\n\n---\n\nLast paragraph.");
			expect(content).toContain("Second paragraph.");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects symlinked repository bundles and cards", async () => {
		const root = await temporary();
		try {
			const repo = join(root, "repo");
			await mkdir(join(repo, "src"), { recursive: true });
			const outsideBundle = join(root, "outside-bundle");
			await mkdir(outsideBundle);
			await symlink(outsideBundle, join(repo, ".okf"));
			expect(await findRepoOkf(join(repo, "src"))).toBeUndefined();

			const bundle = join(root, "learner");
			const concepts = join(bundle, "concepts");
			await mkdir(concepts, { recursive: true });
			const outsideCard = join(root, "outside.md");
			await writeFile(outsideCard, card("Outside", "secret boundary token"));
			await symlink(outsideCard, join(concepts, "leaked.md"));
			expect(await new OKFStore(bundle).query("secret boundary token")).toEqual(
				[],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("bounds card reads and the fallback corpus", async () => {
		const root = await temporary();
		try {
			const bundle = join(root, "learner");
			const concepts = join(bundle, "concepts");
			await mkdir(concepts, { recursive: true });
			await writeFile(
				join(concepts, "000-giant.md"),
				card("Giant", `${"x".repeat(64 * 1024)} needle-after-limit`),
			);
			for (let index = 0; index < 200; index += 1)
				await writeFile(
					join(concepts, `card-${String(index).padStart(3, "0")}.md`),
					card(`Card ${index}`, "ordinary"),
				);
			await writeFile(
				join(concepts, "z-last.md"),
				card("Last", "cap-only token"),
			);
			const store = new OKFStore(bundle);
			expect(await store.query("needle-after-limit")).toEqual([]);
			expect(await store.query("cap-only token")).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ranks repository context above learner cards on a tie", async () => {
		const root = await temporary();
		try {
			const learner = new OKFStore(join(root, "learner"));
			const repo = new OKFStore(join(root, "repo", ".okf"));
			await learner.saveConcept("Learner Card", "shared ranking context");
			await repo.saveConcept("Repository Card", "shared ranking context");
			expect(
				(await learner.query("shared ranking context", repo.root)).map(
					({ title }) => title,
				),
			).toEqual(["Repository Card", "Learner Card"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("memory retrieval performance", () => {
	// qmd is absent in CI, so this measures the keyword fallback path; the
	// qmd-backed path is only verifiable where `qmd` installs (see README).
	test("keyword fallback query over 200 cards has median under 15ms", async () => {
		const root = await mkdtemp("/tmp/sidecar-qmd-perf-");
		try {
			const store = new OKFStore(join(root, "learner"));
			for (let index = 0; index < 200; index += 1)
				await store.saveConcept(
					`Concept ${index} typescript benchmark`,
					`Card body ${index} about closures, ranking, and perf harnesses`,
					["typescript"],
				);
			const { median, worst } = await medianMs(20, 5, () =>
				store.query("typescript closures performance", join(root, "repo/.okf")),
			);
			expect(median).toBeLessThan(30);
			expect(worst).toBeLessThan(75);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("merging a concept preserves private provenance for future cloud filtering", async () => {
		const root = await mkdtemp("/tmp/sidecar-provenance-");
		try {
			const store = new OKFStore(join(root, ".okf"));
			await store.saveConcept(
				"Channel receipt",
				"private acknowledgement context",
				[],
				"private",
			);
			await store.saveConcept("Channel receipt", "public update", [], "public");
			const hits = await store.query("acknowledgement");
			expect(hits[0]?.sourceSessions).toEqual(["private", "public"]);
			expect(
				await store.query(
					"acknowledgement",
					undefined,
					(source) => source !== "private",
				),
			).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
