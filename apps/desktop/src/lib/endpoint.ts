declare global {
	interface Window {
		__SIDECAR_PORT__?: string;
	}
}
const configured =
	typeof window === "undefined" ? "4321" : (window.__SIDECAR_PORT__ ?? "4321");
const port =
	/^\d+$/.test(configured) &&
	Number(configured) > 0 &&
	Number(configured) <= 65535
		? configured
		: "4321";
export const daemonUrl = `http://127.0.0.1:${port}`;
export const daemonWsUrl = `${daemonUrl.replace(/^http/, "ws")}/ws`;
