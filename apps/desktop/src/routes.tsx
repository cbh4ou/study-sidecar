import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { HudMessagesProvider } from "./lib/ws";
import { Classroom } from "./pages/Classroom";
import { ClassroomList } from "./pages/ClassroomList";
import { GraphHome } from "./pages/GraphHome";
import { Review } from "./pages/Review";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { VoiceProvider } from "./voice/VoiceProvider";
import { MainApp } from "./windows/MainApp";
import { PillApp } from "./windows/PillApp";

export { desktopRoutes } from "./lib/routes";

const root = createRootRoute({
	component: () => (
		<HudMessagesProvider>
			<VoiceProvider>
				<Outlet />
			</VoiceProvider>
		</HudMessagesProvider>
	),
});
const main = createRoute({
	getParentRoute: () => root,
	id: "workspace",
	component: MainApp,
});
const graph = createRoute({
	getParentRoute: () => main,
	path: "/",
	component: GraphHome,
});
const lessons = createRoute({
	getParentRoute: () => main,
	path: "/classroom",
	component: ClassroomList,
});
const lesson = createRoute({
	getParentRoute: () => main,
	path: "/classroom/$lessonId",
	component: () => <Classroom lessonId={lesson.useParams().lessonId} />,
});
const sessions = createRoute({
	getParentRoute: () => main,
	path: "/sessions",
	component: Sessions,
});
const review = createRoute({
	getParentRoute: () => main,
	path: "/review",
	component: Review,
});
const settings = createRoute({
	getParentRoute: () => main,
	path: "/settings",
	component: Settings,
});
const pill = createRoute({
	getParentRoute: () => root,
	path: "/pill",
	component: PillApp,
});
export const routeTree = root.addChildren([
	main.addChildren([graph, lessons, lesson, sessions, review, settings]),
	pill,
]);
export const router = createRouter({ routeTree });
