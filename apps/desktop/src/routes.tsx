import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
} from "@tanstack/react-router";
import { MentorHud } from "./components/MentorHud";
import { desktopRoutes } from "./lib/routes";
import {
	HudMessagesProvider,
	useHudMessages,
	useSetTutorModel,
	useTutorModels,
	useVoiceUrl,
} from "./lib/ws";
import { useVoice, VoiceProvider } from "./voice/VoiceProvider";

export { desktopRoutes } from "./lib/routes";

function AppFrame() {
	return (
		<HudMessagesProvider>
			<VoiceProvider>
				<main>
					<header className="app-header">
						<div>
							<h1>Study Partner</h1>
							<p>Live coding companion</p>
						</div>
						<nav aria-label="Desktop pages">
							<Link to="/" activeProps={{ className: "active" }}>
								Mentor
							</Link>
							<Link to="/settings" activeProps={{ className: "active" }}>
								Settings
							</Link>
						</nav>
					</header>
					<Outlet />
				</main>
			</VoiceProvider>
		</HudMessagesProvider>
	);
}

function Settings() {
	const { state, setMode } = useHudMessages();
	const { voice, toggleListening, toggleMute } = useVoice();
	const { data: tutorModels } = useTutorModels();
	const setTutorModel = useSetTutorModel();
	const { data: voiceEndpoint } = useVoiceUrl();
	return (
		<section className="settings" aria-label="Settings">
			<h2>Settings</h2>
			<label>
				Study mode
				<select
					value={state.activeMode}
					disabled={!state.modes.length}
					onChange={(event) => setMode(event.currentTarget.value)}
				>
					{state.modes.map((mode) => (
						<option key={mode.name} value={mode.name}>
							{mode.title}
						</option>
					))}
				</select>
			</label>
			<label>
				Model
				<select
					value={tutorModels?.model ?? ""}
					disabled={!tutorModels?.models.length || setTutorModel.isPending}
					onChange={(event) => setTutorModel.mutate(event.currentTarget.value)}
				>
					{!tutorModels?.model && <option value="">Choose a model</option>}
					{tutorModels?.models.map((model) => (
						<option key={model} value={model}>
							{model}
						</option>
					))}
				</select>
			</label>
			{!tutorModels?.models.length && (
				<p role="status">No authenticated Pi models available.</p>
			)}
			{setTutorModel.isError && (
				<p role="alert">Could not change the model. Try again.</p>
			)}
			<div className="card controls">
				<strong>Voice</strong>
				<span>
					{voiceEndpoint?.ws_url
						? "Local worker available"
						: "Local worker offline"}
				</span>
				<button
					type="button"
					onClick={toggleListening}
					disabled={!voiceEndpoint?.ws_url}
				>
					{voice.listening ? "Stop mic" : "Start mic"}
				</button>
				<button type="button" onClick={toggleMute}>
					{voice.muted ? "Unmute" : "Mute"}
				</button>
			</div>
		</section>
	);
}

const rootRoute = createRootRoute({ component: AppFrame });
const mentorRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: desktopRoutes[0],
	component: MentorHud,
});
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: desktopRoutes[1],
	component: Settings,
});
export const routeTree = rootRoute.addChildren([mentorRoute, settingsRoute]);
export const router = createRouter({ routeTree });
