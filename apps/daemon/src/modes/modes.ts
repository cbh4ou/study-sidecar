import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type Chattiness = {
	cooldown_sec: number;
	max_proactive_per_10m: number;
};
export type WakeTriggers = {
	on_tools: string[];
	on_dead_air_ms: number;
	highlight_regex?: string;
};
export type VoiceProfile = {
	provider?: string;
	language?: string;
	accent?: string;
	speed?: number;
};
export type TutorMode = {
	name: string;
	title: string;
	description: string;
	chattiness: Chattiness;
	wake_triggers: WakeTriggers;
	voice: VoiceProfile;
	prompt: string;
	source: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const string = (value: unknown): string | undefined =>
	typeof value === "string" && value ? value : undefined;
const number = (value: unknown, fallback: number): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export function parseFrontmatter(
	text: string,
): [Record<string, unknown>, string] {
	const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)(?:\r?\n|$)/.exec(
		text,
	);
	if (!match) return [{}, text];
	try {
		const fields = record(YAML.parse(match[1] ?? ""));
		return [fields ?? {}, text.slice(match[0].length)];
	} catch {
		return [{}, text];
	}
}

export async function loadModeFile(path: string): Promise<TutorMode> {
	const [fields, body] = parseFrontmatter(await Bun.file(path).text());
	const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
	const chattiness = record(fields.chattiness);
	const wakeTriggers = record(fields.wake_triggers);
	const voice = record(fields.voice);
	const wakeTools = wakeTriggers?.on_tools ?? fields.wake_on_tools;
	return {
		name,
		title:
			string(fields.title) ??
			name
				.replace(/-/g, " ")
				.replace(/\b\w/g, (letter) => letter.toUpperCase()),
		description: string(fields.description) ?? "",
		chattiness: {
			cooldown_sec: number(
				chattiness?.cooldown_sec ?? fields.chattiness_cooldown_sec,
				45,
			),
			max_proactive_per_10m: number(chattiness?.max_proactive_per_10m, 3),
		},
		wake_triggers: {
			on_tools: Array.isArray(wakeTools)
				? wakeTools
						.filter((item): item is string => typeof item === "string")
						.map((item) => item.toLowerCase())
				: typeof wakeTools === "string"
					? [wakeTools.toLowerCase()]
					: ["write", "edit", "bash"],
			on_dead_air_ms: number(wakeTriggers?.on_dead_air_ms, 0),
			highlight_regex: string(wakeTriggers?.highlight_regex),
		},
		voice: {
			provider: string(voice?.provider) ?? string(fields.voice_profile),
			language: string(voice?.language) ?? string(fields.language),
			accent: string(voice?.accent),
			speed: voice?.speed === undefined ? undefined : number(voice.speed, 1),
		},
		prompt: body.trim(),
		source: path,
	};
}

async function modeFiles(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory))
			.filter((name) => name.endsWith(".md"))
			.sort()
			.map((name) => join(directory, name));
	} catch {
		return [];
	}
}

export async function loadModes(
	userDirectory = join(process.env.HOME ?? "", ".study-sidecar", "modes"),
	builtinDirectory = resolve(import.meta.dir, "../../../../modes"),
): Promise<Map<string, TutorMode>> {
	const modes = new Map<string, TutorMode>();
	for (const directory of [builtinDirectory, userDirectory])
		for (const path of await modeFiles(directory)) {
			try {
				const mode = await loadModeFile(path);
				modes.set(mode.name, mode);
			} catch {
				/* skip malformed user mode */
			}
		}
	return modes;
}
