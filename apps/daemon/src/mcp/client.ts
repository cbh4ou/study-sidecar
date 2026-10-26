import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Repo root: apps/daemon/src/mcp -> four levels up. */
export const REPO_ROOT = join(
	dirname(import.meta.path),
	"..",
	"..",
	"..",
	"..",
);
export const TOKEN_PATH = join(REPO_ROOT, ".run", "token");

/** Minimal HTTP client the MCP tools use; tests inject a fake. */
export type DaemonClient = {
	post(path: string, body: unknown): Promise<unknown>;
};

export function daemonBaseUrl(env = process.env): string {
	return `http://127.0.0.1:${env.SIDECAR_PORT ?? 4321}`;
}

export async function daemonToken(
	env = process.env,
	tokenPath = TOKEN_PATH,
): Promise<string> {
	if (env.SIDECAR_TOKEN) return env.SIDECAR_TOKEN;
	try {
		return (await readFile(tokenPath, "utf8")).trim();
	} catch {
		return "";
	}
}

/** Bearer-authenticated JSON POSTs to the loopback daemon. */
export function createDaemonClient(
	options: {
		baseUrl?: string;
		token?: () => Promise<string>;
		fetch?: typeof fetch;
	} = {},
): DaemonClient {
	const baseUrl = options.baseUrl ?? daemonBaseUrl();
	const token = options.token ?? (() => daemonToken());
	const doFetch = options.fetch ?? fetch;
	return {
		async post(path, body) {
			const bearer = await token();
			if (!bearer)
				throw new Error(
					"no daemon token: start the sidecar (`bun run sidecar up`) or set SIDECAR_TOKEN",
				);
			const response = await doFetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${bearer}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			const data: unknown = await response.json().catch(() => undefined);
			if (!response.ok) {
				const message =
					data && typeof data === "object" && "error" in data
						? String((data as { error: unknown }).error)
						: `HTTP ${response.status}`;
				throw new Error(`daemon rejected ${path}: ${message}`);
			}
			return data;
		},
	};
}
