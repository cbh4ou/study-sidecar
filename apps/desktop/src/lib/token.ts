declare global {
	interface Window {
		__SIDECAR_TOKEN__?: string;
	}
}

let cachedToken = "";

/**
 * Resolve the daemon shared token: build-time injection first, then the
 * Tauri `sidecar_token` command, then empty string (dev without supervisor).
 */
export async function getSidecarToken(): Promise<string> {
	if (cachedToken) return cachedToken;
	const injected =
		typeof window === "undefined" ? "" : (window.__SIDECAR_TOKEN__ ?? "");
	if (injected) {
		cachedToken = injected;
		return injected;
	}
	if (typeof window !== "undefined" && "__TAURI__" in window) {
		try {
			// Dynamic import: @tauri-apps/api is platform-specific and absent in
			// browser/bun-test environments; a static import would fail resolution there.
			const { invoke } = await import("@tauri-apps/api/core");
			const token = await invoke<string>("sidecar_token");
			if (token) {
				cachedToken = token;
				return token;
			}
		} catch {
			// The command is unavailable or the bridge rejected the call.
		}
	}
	return "";
}
