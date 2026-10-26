import { join } from "node:path";
import { readJsonFile, writePrivateFile } from "./paths.ts";
import type { SidecarSettings } from "./protocol.ts";
import { SettingsPatchSchema } from "./settings-routes.ts";

/** On-disk settings, including secrets that never leave the daemon. */
export type StoredSettings = {
	hotkeys: Record<string, string>;
	lanes: { fast?: string; deep?: string };
	decide: {
		adapter: "auto" | "jev" | "llm" | "rules";
		threshold: number;
		jevApiKey?: string;
		jevUrl?: string;
	};
	web: { provider: "none" | "brave" | "tavily"; apiKey?: string };
	voice: { mode: "ptt" | "vad"; stt?: string; tts?: string };
	privacy: { defaultLocalOnly: boolean };
	follow: boolean;
};

export const DEFAULT_SETTINGS: StoredSettings = {
	hotkeys: {
		ptt: "Alt+Space",
		expand: "Alt+S",
		open: "Alt+O",
		copy: "Alt+C",
		dnd: "Alt+D",
		pin: "Alt+P",
	},
	lanes: {},
	decide: { adapter: "auto", threshold: 0.7 },
	web: { provider: "none" },
	voice: { mode: "ptt" },
	privacy: { defaultLocalOnly: false },
	follow: true,
};

export type SettingsPatch = {
	hotkeys?: Record<string, string>;
	lanes?: Partial<StoredSettings["lanes"]>;
	decide?: Partial<StoredSettings["decide"]>;
	web?: Partial<StoredSettings["web"]>;
	voice?: Partial<StoredSettings["voice"]>;
	privacy?: Partial<StoredSettings["privacy"]>;
	follow?: boolean;
};

function merge(base: StoredSettings, patch: SettingsPatch): StoredSettings {
	return {
		hotkeys: { ...base.hotkeys, ...patch.hotkeys },
		lanes: { ...base.lanes, ...patch.lanes },
		decide: { ...base.decide, ...patch.decide },
		web: { ...base.web, ...patch.web },
		voice: { ...base.voice, ...patch.voice },
		privacy: { ...base.privacy, ...patch.privacy },
		follow: patch.follow ?? base.follow,
	};
}

/** `settings.json` under the sidecar home; sole writer of that file. */
export class SettingsStore {
	#value: StoredSettings = structuredClone(DEFAULT_SETTINGS);
	#write: Promise<void> = Promise.resolve();
	#listeners = new Set<(settings: StoredSettings) => void>();
	constructor(private readonly root: string) {}

	get path(): string {
		return join(this.root, "settings.json");
	}

	async load(): Promise<StoredSettings> {
		const raw = await readJsonFile<unknown>(this.path, {});
		const parsed = SettingsPatchSchema.safeParse(raw);
		this.#value = merge(DEFAULT_SETTINGS, parsed.success ? parsed.data : {});
		return this.value;
	}
	get value(): StoredSettings {
		const value = structuredClone(this.#value);
		if (process.env.JEV_API_KEY)
			value.decide.jevApiKey = process.env.JEV_API_KEY;
		if (process.env.JEV_API_URL) value.decide.jevUrl = process.env.JEV_API_URL;
		if (process.env.SIDECAR_WEB_API_KEY)
			value.web.apiKey = process.env.SIDECAR_WEB_API_KEY;
		return value;
	}

	async update(patch: SettingsPatch): Promise<StoredSettings> {
		this.#value = merge(this.#value, patch);
		const snapshot = `${JSON.stringify(this.#value, null, 2)}\n`;
		const write = this.#write.then(() => writePrivateFile(this.path, snapshot));
		this.#write = write.catch(() => undefined);
		await write;
		for (const listener of this.#listeners) listener(this.value);
		return this.value;
	}

	onChange(listener: (settings: StoredSettings) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The client-visible view: secrets replaced by `configured` flags. */
	public(): SidecarSettings {
		const value = this.value;
		return {
			hotkeys: { ...value.hotkeys },
			lanes: { ...value.lanes },
			decide: {
				adapter: value.decide.adapter,
				threshold: value.decide.threshold,
				jevConfigured: Boolean(value.decide.jevApiKey),
			},
			web: {
				provider: value.web.provider,
				configured: Boolean(value.web.apiKey),
			},
			voice: { ...value.voice },
			privacy: { ...value.privacy },
			follow: value.follow,
		};
	}
}
