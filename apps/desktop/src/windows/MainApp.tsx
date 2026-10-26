import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { ActivityDock } from "../components/ActivityDock";
import { useLiveInvalidation } from "../lib/api";
import { useHudMessages } from "../lib/ws";
export function MainApp() {
	useLiveInvalidation();
	const navigate = useNavigate();
	const { state, connection } = useHudMessages();
	useEffect(() => {
		if (!("__TAURI_INTERNALS__" in window)) return;
		let disposed = false;
		let stop: (() => void) | undefined;
		void listen<string>(
			"app://navigate",
			(e) => void navigate({ to: e.payload }),
		).then((next) => {
			if (disposed) next();
			else stop = next;
		});
		return () => {
			disposed = true;
			stop?.();
		};
	}, [navigate]);
	return (
		<div className="main-app">
			<aside className="main-sidebar">
				<Link to="/" className="brand">
					Study Sidecar
				</Link>
				<nav aria-label="Main navigation">
					<Link
						to="/"
						activeOptions={{ exact: true }}
						activeProps={{ className: "active" }}
					>
						Graph
					</Link>
					<Link to="/classroom" activeProps={{ className: "active" }}>
						Classroom
					</Link>
					<Link to="/sessions" activeProps={{ className: "active" }}>
						Sessions
					</Link>
					<Link to="/review" activeProps={{ className: "active" }}>
						Review {state.dueCount ? `(${state.dueCount})` : ""}
					</Link>
					<Link to="/settings" activeProps={{ className: "active" }}>
						Settings
					</Link>
				</nav>
				<p>One concept at a time.</p>
			</aside>
			<div className="main-workspace">
				<header className="main-topbar">
					<span>{state.session?.project ?? "Your study workspace"}</span>
					<span role="status">{connection}</span>
				</header>
				<main className="main-content">
					<Outlet />
				</main>
			</div>
			<ActivityDock />
		</div>
	);
}
