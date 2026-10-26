import type { Proposition, SourceRef } from "../protocol.ts";
import type { PrivacyGate } from "../services.ts";
export function sourcePath(ref: SourceRef): string {
	return ref.kind === "session"
		? (ref.file ?? ref.sessionId)
		: ref.kind === "lesson"
			? ref.lessonId
			: ref.kind === "web"
				? ref.url
				: ref.path;
}
export function privateProposition(
	node: Proposition,
	privacy?: PrivacyGate,
): boolean {
	return !!(
		privacy?.isLocalOnly(node.birthSource) ||
		node.sources.some((ref) => privacy?.isLocalOnly(sourcePath(ref)))
	);
}
