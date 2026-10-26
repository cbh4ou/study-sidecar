import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "./components/ui/tooltip";
import { router } from "./routes";
import "./styles.css";

if ("__TAURI__" in window) document.documentElement.classList.add("tauri");

if (
	new URLSearchParams(location.search).get("window") === "pill" &&
	location.pathname !== "/pill"
)
	history.replaceState(null, "", `/pill${location.search}`);
if (
	new URLSearchParams(location.search).get("window") === "main" &&
	location.pathname.endsWith("index.html")
)
	history.replaceState(null, "", `/${location.search}`);
const queryClient = new QueryClient();

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root") ?? document.body).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	</StrictMode>,
);
