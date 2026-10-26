import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	type DaemonContext,
	type Feature,
	json,
	readBody,
} from "../feature.ts";
import { readJsonFile, writePrivateFile } from "../paths.ts";
import type { PrivacyGate } from "../services.ts";
import { redact } from "../tutor/redact.ts";

export type SourceFlags = { local_only: boolean; index_graph: boolean };
export type SourceMap = Record<string, SourceFlags>;

const MAX_PATH = 4_096;

function normalizePath(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

/** `child` equals `parent` or lives under it (path-segment aligned). */
export function underPath(child: string, parent: string): boolean {
	const a = normalizePath(child);
	const b = normalizePath(parent);
	return a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
}

function isFlags(value: unknown): value is SourceFlags {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as SourceFlags).local_only === "boolean" &&
		typeof (value as SourceFlags).index_graph === "boolean"
	);
}

/**
 * `<root>/sources.json`: per-source privacy flags. Sole writer of that file.
 * A flag on a path also covers everything under it (longest match wins), and
 * a local_only session extends to files under that session's working dir.
 */
export class SourcePrivacy implements PrivacyGate {
	#sources: SourceMap = {};
	#cwds = new Map<string, string>();
	#loaded?: Promise<void>;
	#write: Promise<void> = Promise.resolve();

	constructor(
		private readonly root: string,
		private readonly defaults: () => { defaultLocalOnly: boolean } = () => ({
			defaultLocalOnly: false,
		}),
	) {}

	get path(): string {
		return join(this.root, "sources.json");
	}

	load(): Promise<void> {
		this.#loaded ??= readJsonFile<unknown>(this.path, {}).then((raw) => {
			const next: SourceMap = {};
			if (raw && typeof raw === "object" && !Array.isArray(raw))
				for (const [path, flags] of Object.entries(raw))
					if (isFlags(flags)) next[normalizePath(path)] = { ...flags };
			// Writes that happened before the file finished loading win.
			this.#sources = { ...next, ...this.#sources };
		});
		return this.#loaded;
	}

	list(): SourceMap {
		return structuredClone(this.#sources);
	}

	/** Explicit flags for a path (or the longest flagged ancestor). */
	#match(path: string): SourceFlags | undefined {
		let best: string | undefined;
		for (const key of Object.keys(this.#sources))
			if (underPath(path, key) && (!best || key.length > best.length))
				best = key;
		return best ? this.#sources[best] : undefined;
	}

	/** Record a session's working directory so its files inherit its flags. */
	linkSessionCwd(sessionPath: string, cwd: string): void {
		if (cwd) this.#cwds.set(normalizePath(sessionPath), normalizePath(cwd));
	}

	isLocalOnly(sourcePath?: string): boolean {
		const fallback = this.defaults().defaultLocalOnly;
		if (!sourcePath) return fallback;
		sourcePath = normalizePath(sourcePath);
		const direct = this.#match(sourcePath);
		if (direct) return direct.local_only;
		for (const [session, cwd] of this.#cwds)
			if (underPath(sourcePath, cwd) && this.#match(session)?.local_only)
				return true;
		return fallback;
	}

	allowCloud(sourcePath?: string): boolean {
		return !this.isLocalOnly(sourcePath);
	}

	redact(text: string): string {
		return redact(text);
	}

	indexIntoGraph(sourcePath?: string): boolean {
		if (this.isLocalOnly(sourcePath)) return false;
		if (!sourcePath) return true;
		return this.#match(normalizePath(sourcePath))?.index_graph ?? true;
	}

	async set(
		path: string,
		patch: { local_only?: boolean; index_graph?: boolean },
	): Promise<SourceFlags> {
		await this.load();
		const key = normalizePath(path);
		const current = this.#sources[key] ?? {
			local_only: this.isLocalOnly(key),
			index_graph: this.#match(key)?.index_graph ?? true,
		};
		const next: SourceFlags = {
			local_only: patch.local_only ?? current.local_only,
			index_graph: patch.index_graph ?? current.index_graph,
		};
		this.#sources[key] = next;
		const snapshot = `${JSON.stringify(this.#sources, null, 2)}\n`;
		const run = this.#write.then(() => writePrivateFile(this.path, snapshot));
		this.#write = run.catch(() => undefined);
		await run;
		return next;
	}
}

const SourcePatch = z.object({
	path: z.string().min(1).max(MAX_PATH),
	local_only: z.boolean().optional(),
	index_graph: z.boolean().optional(),
});

/** Registers `services.privacy` synchronously; serves `/api/sources`. */
export function createPrivacyFeature(
	context: DaemonContext,
	gate = new SourcePrivacy(context.root, () => context.settings.value.privacy),
): Feature {
	context.services.privacy = gate;
	return {
		name: "privacy",
		start: () => gate.load(),
		async route(request, url, cors) {
			if (url.pathname !== "/api/sources") return undefined;
			await gate.load();
			if (request.method === "GET") return json({ sources: gate.list() }, cors);
			if (request.method !== "POST")
				return json({ error: "method not allowed" }, cors, 405);
			const parsed = SourcePatch.safeParse(await readBody(request));
			if (!parsed.success)
				return json(
					{
						error:
							"body must be { path, local_only?: boolean, index_graph?: boolean }",
					},
					cors,
					400,
				);
			const { path, local_only, index_graph } = parsed.data;
			await gate.set(path, { local_only, index_graph });
			context.broadcast({ type: "sessions_changed" });
			return json({ ok: true }, cors);
		},
	};
}
