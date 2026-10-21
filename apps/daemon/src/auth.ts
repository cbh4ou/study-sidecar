import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULT_PORT = 4321;

export function generateToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
		"base64url",
	);
}

export function tokenEquals(
	actual: string | null | undefined,
	expected: string,
): boolean {
	if (!actual || !expected) return false;
	const left = createHash("sha256").update(actual).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}

export function requestToken(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (header?.toLowerCase().startsWith("bearer ")) {
		return header.slice(7).trim();
	}
	return new URL(request.url).searchParams.get("token") ?? undefined;
}

const LOOPBACK_HOSTS: Record<string, true> = {
	"127.0.0.1": true,
	localhost: true,
};
const EXTRA_ORIGINS: Record<string, true> = {
	"tauri://localhost": true,
	"http://tauri.localhost": true,
};

export function hostAllowed(host: string | null): boolean {
	if (!host) return false;
	const hostname = host
		.replace(/^\[/, "")
		.split("]")[0]
		?.split(":")[0]
		?.toLowerCase();
	return (hostname ?? "") in LOOPBACK_HOSTS;
}

export function allowedOrigin(origin: string | null): string | null {
	if (!origin) return null;
	if (origin in EXTRA_ORIGINS) return origin;
	try {
		const url = new URL(origin);
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.hostname.toLowerCase() in LOOPBACK_HOSTS
		) {
			return origin;
		}
	} catch {
		// Malformed origins are simply not allowlisted.
	}
	return null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
	const allowed = allowedOrigin(origin);
	if (!allowed) return {};
	return {
		"Access-Control-Allow-Origin": allowed,
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	};
}
