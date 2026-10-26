import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Root of everything the sidecar owns (`~/.study-sidecar`). `SIDECAR_HOME`
 * overrides it so tests and fake mode never touch the real home directory.
 */
export function sidecarHome(home = process.env.HOME ?? ""): string {
	return process.env.SIDECAR_HOME || join(home, ".study-sidecar");
}

/** Create a 0700 directory (and parents) owned by the sidecar. */
export async function ensurePrivateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700).catch(() => undefined);
}

/** Atomically replace a 0600 file. */
export async function writePrivateFile(
	path: string,
	content: string,
): Promise<void> {
	await ensurePrivateDir(dirname(path));
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, content, { mode: 0o600 });
	await rename(temp, path);
	await chmod(path, 0o600).catch(() => undefined);
}

/** Append one JSON line to a 0600 append-only ledger. */
export async function appendJsonLine(
	path: string,
	value: unknown,
): Promise<void> {
	await ensurePrivateDir(dirname(path));
	await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await chmod(path, 0o600).catch(() => undefined);
}

/**
 * Read a JSONL ledger. Invalid or non-matching lines are dropped, never
 * guessed; a missing file is an empty ledger.
 */
export async function readJsonLines<T>(
	path: string,
	guard: (value: unknown) => value is T,
): Promise<T[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (guard(value)) out.push(value);
		} catch {
			// corrupt line: skip
		}
	}
	return out;
}

/** Read a JSON file or return the fallback when missing or malformed. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}
