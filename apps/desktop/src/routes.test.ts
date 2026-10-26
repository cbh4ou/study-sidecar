import { expect, test } from "bun:test";
import { desktopRoutes } from "./lib/routes";

test("desktop routing exposes every MVP surface exactly once", () => {
	expect(desktopRoutes).toEqual([
		"/",
		"/classroom",
		"/classroom/$lessonId",
		"/sessions",
		"/review",
		"/settings",
		"/pill",
	]);
	expect(desktopRoutes.filter((path) => path === "/")).toHaveLength(1);
	expect(desktopRoutes.filter((path) => path === "/settings")).toHaveLength(1);
});
