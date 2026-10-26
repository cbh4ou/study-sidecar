import { join } from "node:path";
import { readJsonFile, writePrivateFile } from "./paths.ts";
import type { SidecarSettings } from "./protocol.ts";

/** On-disk settings, including secrets that never leave the daemon. */
export type StoredSettings = {
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
	lanes: {},
	decide: { adapter: "auto", threshold: 0.7 },
	web: { provider: "none" },
	voice: { mode: "ptt" },
	privacy: { defaultLocalOnly: false },
	follow: true,
};

export type SettingsPatch = {
	lanes?: Partial<StoredSettings["lanes"]>;
	decide?: Partial<StoredSettings["decide"]>;
	web?: Partial<StoredSettings["web"]>;
	voice?: Partial<StoredSettings["voice"]>;
	privacy?: Partial<StoredSettings["privacy"]>;
	follow?: boolean;
};

function merge(base: StoredSettings, patch: SettingsPatch): StoredSettings {
	return {
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
	#value: StoredSettings = DEFAULT_SETTINGS;
	#listeners = new Set<(settings: StoredSettings) => void>();
	constructor(private readonly root: string) {}

	get path(): string {
		return join(this.root, "settings.json");
	}

	async load(): Promise<StoredSettings> {
		const raw = await readJsonFile<SettingsPatch>(this.path, {});
		this.#value = merge(
			DEFAULT_SETTINGS,
			raw && typeof raw === "object" ? raw : {},
		);
		// Environment wins for secrets so they need not touch disk.
		if (process.env.JEV_API_KEY)
			this.#value.decide.jevApiKey = process.env.JEV_API_KEY;
		if (process.env.JEV_API_URL)
			this.#value.decide.jevUrl = process.env.JEV_API_URL;
		if (process.env.SIDECAR_WEB_API_KEY)
			this.#value.web.apiKey = process.env.SIDECAR_WEB_API_KEY;
		return this.#value;
	}

	get value(): StoredSettings {
		return this.#value;
	}

	async update(patch: SettingsPatch): Promise<StoredSettings> {
		this.#value = merge(this.#value, patch);
		await writePrivateFile(
			this.path,
			`${JSON.stringify(this.#value, null, 2)}\n`,
		);
		for (const listener of this.#listeners) listener(this.#value);
		return this.#value;
	}

	onChange(listener: (settings: StoredSettings) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The client-visible view: secrets replaced by `configured` flags. */
	public(): SidecarSettings {
		const value = this.#value;
		return {
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
