import { describe, expect, test } from "bun:test";
import {
	allowedOrigin,
	corsHeaders,
	generateToken,
	hostAllowed,
	requestToken,
	tokenEquals,
} from "./auth.ts";

describe("token", () => {
	test("generates 24-byte base64url tokens", () => {
		const token = generateToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(token).not.toBe(generateToken());
	});
	test("compares without length leaks and rejects missing values", () => {
		expect(tokenEquals("secret", "secret")).toBe(true);
		expect(tokenEquals("secreu", "secret")).toBe(false);
		expect(tokenEquals("", "secret")).toBe(false);
		expect(tokenEquals(undefined, "secret")).toBe(false);
		expect(tokenEquals("secret", "")).toBe(false);
	});
	test("reads bearer header or query parameter", () => {
		const header = new Request("http://127.0.0.1:4321/health", {
			headers: { Authorization: "Bearer abc" },
		});
		expect(requestToken(header)).toBe("abc");
		const query = new Request("http://127.0.0.1:4321/health?token=abc");
		expect(requestToken(query)).toBe("abc");
		expect(
			requestToken(new Request("http://127.0.0.1:4321/health")),
		).toBeUndefined();
	});
});

describe("host allowlist", () => {
	test("accepts loopback hostnames with any port", () => {
		expect(hostAllowed("127.0.0.1")).toBe(true);
		expect(hostAllowed("127.0.0.1:4321")).toBe(true);
		expect(hostAllowed("localhost")).toBe(true);
		expect(hostAllowed("LOCALHOST:5173")).toBe(true);
	});
	test("rejects foreign and missing hosts", () => {
		expect(hostAllowed("evil.com")).toBe(false);
		expect(hostAllowed("127.0.0.1.evil.com:4321")).toBe(false);
		expect(hostAllowed("[::1]:4321")).toBe(false);
		expect(hostAllowed(null)).toBe(false);
	});
});

describe("origin allowlist", () => {
	test("echoes allowlisted loopback and Tauri origins", () => {
		for (const origin of [
			"http://localhost:5173",
			"https://127.0.0.1:3000",
			"http://localhost",
			"tauri://localhost",
			"http://tauri.localhost",
		]) {
			expect(allowedOrigin(origin)).toBe(origin);
			expect(corsHeaders(origin)).toEqual({
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			});
		}
	});
	test("grants no CORS headers to foreign or absent origins", () => {
		expect(allowedOrigin("https://evil.com")).toBeNull();
		expect(allowedOrigin("http://sub.localhost:5173")).toBeNull();
		expect(allowedOrigin("not a url")).toBeNull();
		expect(corsHeaders("https://evil.com")).toEqual({});
		expect(corsHeaders(null)).toEqual({});
	});
});
