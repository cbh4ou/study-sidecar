import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const registered = new Set<string>();
const indexed = new Set<string>();
// ponytail: Bun.which re-scans PATH (~20ms) for every miss; presence can't change mid-process
let qmdPath: string | null = null;
let probed = false;

export function resetQmdProbeForTest(): void {
	qmdPath = null;
	probed = false;
	registered.clear();
	indexed.clear();
}

export function setQmdPathForTest(path: string): void {
	qmdPath = path;
	probed = true;
}

export function qmdCollection(
	root: string,
	bundle: "learner" | "repo",
): string {
	const digest = createHash("sha256")
		.update(resolve(root))
		.digest("hex")
		.slice(0, 12);
	return `sidecar-${bundle}-${digest}`;
}

async function run(
	args: string[],
	cwd: string,
	stateRoot: string,
): Promise<string | undefined> {
	if (!probed) {
		qmdPath = Bun.which("qmd");
		probed = true;
	}
	if (!qmdPath) return undefined;
	try {
		const config = join(stateRoot, "qmd");
		const cache = join(stateRoot, "cache");
		await Promise.all([
			mkdir(config, { recursive: true, mode: 0o700 }),
			mkdir(cache, { recursive: true, mode: 0o700 }),
		]);
		await Promise.all([chmod(config, 0o700), chmod(cache, 0o700)]);
		const child = Bun.spawn([qmdPath, ...args], {
			cwd,
			env: {
				...Bun.env,
				QMD_CONFIG_DIR: config,
				XDG_CACHE_HOME: cache,
			},
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = await new Response(child.stdout).text();
		return (await child.exited) === 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

export async function indexQmd(
	root: string,
	bundle: "learner" | "repo",
	stateRoot: string,
): Promise<boolean> {
	const key = `${stateRoot}:${bundle}:${root}`;
	const collection = qmdCollection(root, bundle);
	if (!registered.has(key)) {
		const added = await run(
			["collection", "add", root, "--name", collection],
			root,
			stateRoot,
		);
		if (added === undefined) return false;
		registered.add(key);
	}
	return (await run(["update"], root, stateRoot)) !== undefined;
}

export async function ensureIndexed(
	root: string,
	bundle: "learner" | "repo",
	stateRoot: string,
): Promise<void> {
	const key = `${stateRoot}:${bundle}:${root}`;
	if (indexed.has(key)) return;
	if (await indexQmd(root, bundle, stateRoot)) indexed.add(key);
}

export async function qmdPaths(
	query: string,
	root: string,
	bundle: "learner" | "repo",
	stateRoot: string,
): Promise<string[]> {
	const output = await run(
		[
			"query",
			query,
			"-c",
			qmdCollection(root, bundle),
			"-n",
			"3",
			"--files",
			"--no-rerank",
		],
		root,
		stateRoot,
	);
	if (!output) return [];
	const rootPath = resolve(root);
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		const candidate =
			line.match(/^qmd:\/\/[^/]+\/(.+\.md)$/)?.[1] ??
			line.match(/(?:^|\s)(\/[^\s]+\.md)/)?.[1] ??
			line.match(/(?:concepts\/)?[^\s]+\.md/)?.[0];
		if (!candidate) continue;
		const path = candidate.startsWith("/")
			? resolve(candidate)
			: resolve(rootPath, candidate);
		if (
			(path === rootPath || path.startsWith(`${rootPath}/`)) &&
			!seen.has(path)
		) {
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}
