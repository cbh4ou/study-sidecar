export type Connection =
	| "waiting"
	| "connected"
	| "reconnecting"
	| "unauthorized";

/** Map a daemon HTTP status to a connection state, or null when it carries no auth signal. */
export function mapStatusToConnection(status: number): Connection | null {
	return status === 401 || status === 403 ? "unauthorized" : null;
}
