import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	availableTutorModels,
	saveTutorModel,
	selectTutorModel,
} from "./model-selection.ts";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

test("chooses and persists an authenticated model when no default exists", async () => {
	const home = await mkdtemp("/tmp/sidecar-model-");
	temporary.push(home);
	const agent = join(home, ".pi", "agent");
	await mkdir(agent, { recursive: true });
	await writeFile(
		join(agent, "models-store.json"),
		JSON.stringify({
			one: {
				models: [
					{
						id: "a",
						provider: "one",
						api: "openai-completions",
						baseUrl: "http://example.test",
					},
				],
			},
			two: {
				models: [
					{
						id: "b",
						provider: "two",
						api: "openai-completions",
						baseUrl: "http://example.test",
					},
				],
			},
		}),
	);
	await writeFile(
		join(agent, "auth.json"),
		JSON.stringify({ one: { key: "test" } }),
	);
	expect(await availableTutorModels(home)).toEqual(["one/a"]);
	expect((await selectTutorModel(home)).model).toBe("one/a");
	expect(
		JSON.parse(
			await readFile(join(home, ".study-sidecar", "model.json"), "utf8"),
		),
	).toEqual({ model: "one/a" });
	await saveTutorModel(home, "two/b");
	expect((await selectTutorModel(home)).model).toBe("one/a");
	await expect(selectTutorModel(home, "two/b")).rejects.toThrow(
		"unauthenticated",
	);
});
