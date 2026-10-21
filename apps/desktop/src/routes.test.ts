import { expect, test } from "bun:test";
import { desktopRoutes } from "./lib/routes";

test("desktop routing exposes workbench and settings exactly once", () => {
	expect(desktopRoutes).toEqual(["/", "/settings"]);
	expect(desktopRoutes.filter((path) => path === "/")).toHaveLength(1);
	expect(desktopRoutes.filter((path) => path === "/settings")).toHaveLength(1);
});
