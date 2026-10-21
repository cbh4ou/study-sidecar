import { describe, expect, mock, test } from "bun:test";
import { getSidecarToken } from "./token";

type TestWindow = Omit<typeof globalThis, "window"> & {
	window?: unknown;
	__SIDECAR_TOKEN__?: string;
	__TAURI__?: unknown;
};

function freshImport(query: string) {
	// Distinct specifier => a fresh module instance with an empty token cache.
	return import(`./token?${query}`) as Promise<typeof import("./token")>;
}

describe("sidecar token resolution", () => {
	test("prefers the injected window token over the Tauri command", async () => {
		const scope = globalThis as unknown as TestWindow;
		scope.window = globalThis;
		scope.__SIDECAR_TOKEN__ = "injected-token";
		scope.__TAURI__ = {};
		const module = await freshImport("injected");
		expect(await module.getSidecarToken()).toBe("injected-token");
	});

	test("falls back to the Tauri sidecar_token command", async () => {
		const scope = globalThis as unknown as TestWindow;
		delete scope.__SIDECAR_TOKEN__;
		scope.__TAURI__ = {};
		mock.module("@tauri-apps/api/core", () => ({
			invoke: async () => "tauri-token",
		}));
		const module = await freshImport("tauri");
		expect(await module.getSidecarToken()).toBe("tauri-token");
	});

	test("resolves to an empty string outside Tauri without injection", async () => {
		const scope = globalThis as unknown as TestWindow;
		delete scope.__SIDECAR_TOKEN__;
		delete scope.__TAURI__;
		const module = await freshImport("empty");
		expect(await module.getSidecarToken()).toBe("");
	});

	test("base module still resolves", () => {
		expect(typeof getSidecarToken).toBe("function");
	});
});
