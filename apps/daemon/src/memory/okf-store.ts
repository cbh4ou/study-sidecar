import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseFrontmatter } from "../modes/modes.ts";
import { sidecarHome } from "../paths.ts";
import { ensureIndexed, indexQmd, qmdPaths } from "./qmd-client.ts";

export type MemoryHit = {
	bundle: "learner" | "repo";
	title: string;
	preview: string;
	sourceSessions?: string[];
};
type RankedHit = { score: number; hit: MemoryHit };
const singleLine = (value: string) =>
	value
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "---")
		.join(" ");
const yamlScalar = (value: string) =>
	value.includes(": ") || value !== value.trim()
		? JSON.stringify(value)
		: value;
const slugify = (value: string) =>
	value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase() || "concept";
const decoder = new TextDecoder();

async function atomicWrite(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const file = await open(temp, "w", 0o600);
	try {
		await file.writeFile(content);
		await file.sync();
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	await file.close();
	await rename(temp, path);
}

async function readCard(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const data = new Uint8Array(64 * 1024);
		const { bytesRead } = await file.read(data, 0, data.length, 0);
		return decoder.decode(data.subarray(0, bytesRead));
	} finally {
		await file.close();
	}
}

function bodyPreview(body: string): string {
	return (
		body
			.replace(/^\s*# .*\n?/, "")
			.split(/\n\s*\n/)[0]
			?.replace(/\s+/g, " ")
			.trim()
			.slice(0, 160) ?? ""
	);
}

export class OKFStore {
	constructor(readonly root = join(sidecarHome(), ".okf")) {}

	async saveConcept(
		title: string,
		body: string,
		topics: string[] = ["general"],
		sourceSession = "unknown",
		mermaid?: string,
		tool_use_id?: string,
		sourcePaths: string[] = [],
	): Promise<string> {
		title = singleLine(title) || "Untitled";
		const slug = slugify(title);
		const concepts = join(this.root, "concepts");
		const target = join(concepts, `${slug}.md`);
		const now = new Date();
		let prior = "";
		let priorSourceSession: string | undefined;
		let priorSources: string[] = [];
		let priorToolUse: string | undefined;
		try {
			const [oldFields, oldBody] = parseFrontmatter(
				await readFile(target, "utf8"),
			);
			priorSources = Array.isArray(oldFields.source_sessions)
				? oldFields.source_sessions.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
			prior = oldBody.replace(/^\s*# [^\n]*(?:\n|$)/, "").trim();
			priorSourceSession =
				typeof oldFields.source_session === "string"
					? oldFields.source_session
					: undefined;
			priorToolUse =
				typeof oldFields.source_tool_use === "string"
					? oldFields.source_tool_use
					: undefined;
		} catch {
			/* new card */
		}
		if (prior)
			body = `${prior}\n\n## Update ${now.toISOString().slice(0, 10)}\n\n${body.trim()}`;
		if (mermaid?.trim())
			body = `${body.trim()}\n\n\`\`\`mermaid\n${mermaid.trim()}\n\`\`\``;
		const safeTopics = topics.filter((topic) =>
			/^[A-Za-z0-9._/-]+$/.test(topic),
		);
		if (!safeTopics.length) safeTopics.push("general");
		const updated = now.toISOString().replace(/\.\d{3}Z$/, "Z");
		const stale = new Date(now.getTime() + 30 * 86_400_000)
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z");
		const sourceToolUse = tool_use_id?.trim() || priorToolUse;
		const effectiveSourceSession =
			sourceSession === "unknown"
				? (priorSourceSession ?? sourceSession)
				: sourceSession;
		const sourceSessions = [
			...new Set([
				...priorSources,
				...sourcePaths,
				...(priorSourceSession ? [priorSourceSession] : []),
				effectiveSourceSession,
			]),
		];
		const frontmatter = `---\ntype: concept\nid: concepts/${slug}\ntitle: ${yamlScalar(title)}\ntopics: [${safeTopics.join(", ")}]\ntrust: practicing\nmastery: learning\nsource_session: ${yamlScalar(singleLine(effectiveSourceSession) || "unknown")}${sourceToolUse ? `\nsource_tool_use: ${yamlScalar(singleLine(sourceToolUse))}` : ""}\nsource_sessions: ${JSON.stringify(sourceSessions)}\nupdated_at: ${updated}\nstale_after: ${stale}\n---\n`;
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700);
		await mkdir(concepts, { recursive: true, mode: 0o700 });
		await chmod(concepts, 0o700);
		await atomicWrite(target, `${frontmatter}\n# ${title}\n\n${body.trim()}\n`);
		await indexQmd(this.root, "learner", dirname(this.root));
		return target;
	}

	async query(
		text: string,
		repoRoot?: string,
		allowSource?: (source: string) => boolean,
	): Promise<MemoryHit[]> {
		const learner = await this.queryBundle(text, this.root, "learner");
		const repo = repoRoot ? await this.queryBundle(text, repoRoot, "repo") : [];
		return [...repo, ...learner]
			.filter(
				({ hit }) =>
					!allowSource || (hit.sourceSessions ?? []).every(allowSource),
			)
			.sort(
				(left, right) =>
					right.score - left.score ||
					(left.hit.bundle === right.hit.bundle
						? 0
						: left.hit.bundle === "repo"
							? -1
							: 1),
			)
			.slice(0, 3)
			.map(({ hit }) => hit);
	}

	private async queryBundle(
		text: string,
		root: string,
		bundle: "learner" | "repo",
	): Promise<RankedHit[]> {
		let rootReal: string;
		try {
			rootReal = await realpath(root);
		} catch {
			return [];
		}
		const stateRoot = dirname(this.root);
		await ensureIndexed(root, bundle, stateRoot);
		const qmd = await qmdPaths(text, root, bundle, stateRoot);
		const ranks = new Map(
			qmd.map((path, index) => [resolve(path), 1000 - index]),
		);
		const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
		const terms = text.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [];
		let names: string[];
		try {
			names = (await readdir(join(root, "concepts"), { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
				.map((entry) => entry.name)
				.sort()
				.slice(0, 200);
		} catch {
			return [];
		}
		// ponytail: cap fallback retrieval at 200 cards; add an index only if this ceiling becomes limiting.
		const corpus = await Promise.all(
			names.map(async (name) => {
				const path = join(root, "concepts", name);
				if (ranks.size && !ranks.has(resolve(path))) return undefined;
				try {
					const actual = await realpath(path);
					if (!actual.startsWith(rootPrefix)) return undefined;
					return [name, await readCard(actual)] as const;
				} catch {
					return undefined;
				}
			}),
		);
		const scored: RankedHit[] = [];
		for (const entry of corpus) {
			if (!entry) continue;
			const [name, content] = entry;
			const [fields, body] = parseFrontmatter(content);
			const preview = bodyPreview(body);
			const haystack =
				`${fields.title ?? ""} ${Array.isArray(fields.topics) ? fields.topics.join(" ") : (fields.topics ?? "")} ${preview}`.toLowerCase();
			const score =
				ranks.get(resolve(join(root, "concepts", name))) ??
				terms.filter((term) => haystack.includes(term)).length;
			if (score)
				scored.push({
					score,
					hit: {
						bundle,
						title: String(fields.title ?? name.replace(/\.md$/, "")),
						preview,
						sourceSessions: Array.isArray(fields.source_sessions)
							? fields.source_sessions.filter(
									(value): value is string => typeof value === "string",
								)
							: typeof fields.source_session === "string"
								? [fields.source_session]
								: [],
					},
				});
		}
		return scored.sort((left, right) => right.score - left.score);
	}
}

export async function findRepoOkf(cwd?: string): Promise<string | undefined> {
	if (!cwd) return undefined;
	let directory = cwd;
	for (let level = 0; level < 5; level += 1) {
		const candidate = join(directory, ".okf");
		if ((await lstat(candidate).catch(() => undefined))?.isDirectory())
			return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}
