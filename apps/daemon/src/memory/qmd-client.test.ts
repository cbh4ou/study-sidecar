import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	qmdCollection,
	qmdPaths,
	resetQmdProbeForTest,
	setQmdPathForTest,
} from "./qmd-client.ts";

test("preserves QMD rank order with a scoped file query", async () => {
	const root = await mkdtemp("/tmp/sidecar-qmd-");
	try {
		const bin = join(root, "bin");
		await mkdir(bin);
		const args = join(root, "args");
		const executable = join(bin, "qmd");
		await writeFile(
			executable,
			`#!/bin/sh\nprintf "%s\\n" "$@" > "${args}"\nprintf "qmd://sidecar/concepts/second.md\\nconcepts/first.md\\nconcepts/second.md\\n"\n`,
		);
		await chmod(executable, 0o755);
		setQmdPathForTest(executable);
		expect(qmdCollection(root, "repo")).not.toBe(
			qmdCollection(join(root, "other"), "repo"),
		);
		expect(await qmdPaths("rank me", root, "learner", root)).toEqual([
			join(root, "concepts/second.md"),
			join(root, "concepts/first.md"),
		]);
		expect(await readFile(args, "utf8")).toBe(
			`query\nrank me\n-c\n${qmdCollection(root, "learner")}\n-n\n3\n--files\n--no-rerank\n`,
		);
	} finally {
		resetQmdProbeForTest();
		await rm(root, { recursive: true, force: true });
	}
});
