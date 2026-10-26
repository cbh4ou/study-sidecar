import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useSettings, useUpdateSettings } from "../lib/api";
import { useHudMessages, useSetTutorModel, useTutorModels } from "../lib/ws";
import { useVoice } from "../voice/VoiceProvider";
export function Settings() {
	const { data: settings, error } = useSettings();
	const update = useUpdateSettings();
	const { state, setMode, send } = useHudMessages();
	const { data: models } = useTutorModels();
	const setModel = useSetTutorModel();
	const { voice, toggleMute, toggleListening, configure } = useVoice();
	const [webKey, setWebKey] = useState("");
	const [jevKey, setJevKey] = useState("");
	const [shortcutError, setShortcutError] = useState("");
	if (error) return <p role="alert">{error.message}</p>;
	if (!settings) return <p>Loading settings…</p>;
	const saveHotkey = async (action: string, key: string) => {
		if (key === settings.hotkeys[action]) return;
		const next = { ...settings.hotkeys, [action]: key };
		if (
			Object.values(next).some((value) => !value.trim()) ||
			new Set(Object.values(next).map((value) => value.toLowerCase())).size !==
				Object.keys(next).length
		) {
			setShortcutError("Shortcuts must be nonempty and unique.");
			return;
		}
		try {
			if ("__TAURI_INTERNALS__" in window)
				await invoke("configure_shortcuts", { hotkeys: next });
			await update.mutateAsync({ hotkeys: { [action]: key } });
			setShortcutError("");
		} catch (error) {
			setShortcutError(error instanceof Error ? error.message : String(error));
			if ("__TAURI_INTERNALS__" in window)
				void invoke("configure_shortcuts", { hotkeys: settings.hotkeys }).catch(
					() => undefined,
				);
		}
	};
	return (
		<section className="settings-page">
			<header className="page-heading">
				<h1>Settings</h1>
			</header>
			<fieldset>
				<legend>Tutor</legend>
				<label>
					Study mode
					<select
						value={state.activeMode}
						onChange={(e) => setMode(e.target.value)}
					>
						{state.modes.map((m) => (
							<option key={m.name} value={m.name}>
								{m.title}
							</option>
						))}
					</select>
				</label>
				<label>
					Default model
					<select
						value={models?.model ?? ""}
						onChange={(e) => setModel.mutate(e.target.value)}
					>
						<option value="">Choose a model</option>
						{models?.models.map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</label>
				{(["fast", "deep"] as const).map((lane) => (
					<label key={lane}>
						{lane === "fast" ? "Fast spoken model" : "Deep panel model"}
						<select
							value={settings.lanes[lane] ?? ""}
							onChange={(e) =>
								update.mutate({ lanes: { [lane]: e.target.value } })
							}
						>
							<option value="">Use default</option>
							{models?.models.map((m) => (
								<option key={m}>{m}</option>
							))}
						</select>
					</label>
				))}
			</fieldset>
			<fieldset>
				<legend>Decisions and research</legend>
				<label>
					Decide adapter
					<select
						value={settings.decide.adapter}
						onChange={(e) =>
							update.mutate({
								decide: {
									adapter: e.target.value as typeof settings.decide.adapter,
								},
							})
						}
					>
						{["auto", "jev", "llm", "rules"].map((a) => (
							<option key={a}>{a}</option>
						))}
					</select>
				</label>
				<label>
					Confidence threshold
					<input
						type="number"
						min={0}
						max={1}
						step={0.05}
						value={settings.decide.threshold}
						onChange={(e) =>
							update.mutate({ decide: { threshold: Number(e.target.value) } })
						}
					/>
				</label>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						update.mutate(
							{ decide: { jevApiKey: jevKey } },
							{ onSuccess: () => setJevKey("") },
						);
					}}
				>
					<label>
						Jev API key {settings.decide.jevConfigured ? "(configured)" : ""}
						<input
							type="password"
							autoComplete="off"
							value={jevKey}
							onChange={(e) => setJevKey(e.target.value)}
						/>
					</label>
					<button type="submit">Save Jev key</button>
				</form>
				<label>
					Search provider
					<select
						value={settings.web.provider}
						onChange={(e) =>
							update.mutate({
								web: {
									provider: e.target.value as typeof settings.web.provider,
								},
							})
						}
					>
						<option value="none">None</option>
						<option value="brave">Brave</option>
						<option value="tavily">Tavily</option>
					</select>
				</label>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						update.mutate(
							{ web: { apiKey: webKey } },
							{ onSuccess: () => setWebKey("") },
						);
					}}
				>
					<label>
						Search API key {settings.web.configured ? "(configured)" : ""}
						<input
							type="password"
							autoComplete="off"
							value={webKey}
							onChange={(e) => setWebKey(e.target.value)}
						/>
					</label>
					<button type="submit">Save search key</button>
				</form>
			</fieldset>
			<fieldset>
				<legend>Voice</legend>
				<p>{voice.detail}</p>
				{(["stt", "tts"] as const).map((engine) => (
					<label key={engine}>
						{engine === "stt" ? "Speech recognition" : "Speech synthesis"}
						<select
							value={settings.voice[engine] ?? voice.engines?.[engine][0] ?? ""}
							onChange={(e) => {
								const value = e.target.value;
								update.mutate({ voice: { [engine]: value } });
								configure({ [engine]: value });
							}}
						>
							{voice.engines?.[engine].map((value) => (
								<option key={value}>{value}</option>
							))}
						</select>
					</label>
				))}
				<label>
					<input
						type="checkbox"
						checked={settings.voice.mode === "vad"}
						onChange={(e) =>
							update.mutate({
								voice: { mode: e.target.checked ? "vad" : "ptt" },
							})
						}
					/>
					Optional always listening (VAD)
				</label>
				<button type="button" onClick={toggleListening}>
					{voice.listening ? "Stop microphone" : "Start microphone"}
				</button>
				<button type="button" onClick={toggleMute}>
					{voice.muted ? "Unmute" : "Mute"}
				</button>
			</fieldset>
			<fieldset>
				<legend>Keyboard shortcuts</legend>
				{Object.entries(settings.hotkeys).map(([action, key]) => (
					<label key={`${action}-${key}`}>
						{{
							ptt: "Push to talk",
							expand: "Expand pill",
							open: "Open app",
							copy: "Copy steering prompt",
							dnd: "Do Not Disturb",
							pin: "Pin anchor",
						}[action] ?? action}
						<input
							defaultValue={key}
							onBlur={(event) => void saveHotkey(action, event.target.value)}
						/>
					</label>
				))}
				{shortcutError && <p role="alert">{shortcutError}</p>}
			</fieldset>
			<fieldset>
				<legend>Privacy and binding</legend>
				<label>
					<input
						type="checkbox"
						checked={settings.privacy.defaultLocalOnly}
						onChange={(e) =>
							update.mutate({ privacy: { defaultLocalOnly: e.target.checked } })
						}
					/>
					New sources are local only
				</label>
				<label>
					<input
						type="checkbox"
						checked={settings.follow}
						onChange={(e) => {
							update.mutate({ follow: e.target.checked });
							if (e.target.checked)
								send({ type: "bind_session", sessionPath: null });
						}}
					/>
					Follow the most recently active session
				</label>
			</fieldset>
			{update.error && <p role="alert">{update.error.message}</p>}
		</section>
	);
}
