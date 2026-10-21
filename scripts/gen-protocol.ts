import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HEADER = `// GENERATED from apps/daemon/src/protocol.ts — do not edit by hand.
// Regenerate with \`bun run gen-protocol\`; the drift test enforces byte-identity.

`;
const ROOT = dirname(dirname(import.meta.path));
export const PROTOCOL_SOURCE = join(ROOT, "apps/daemon/src/protocol.ts");
export const PROTOCOL_TARGET = join(ROOT, "apps/desktop/src/lib/protocol.ts");

export function renderProtocolCopy(source: string): string {
	return `${HEADER}${source}`;
}

if (import.meta.main) {
	const copy = renderProtocolCopy(readFileSync(PROTOCOL_SOURCE, "utf8"));
	mkdirSync(dirname(PROTOCOL_TARGET), { recursive: true });
	writeFileSync(PROTOCOL_TARGET, copy);
	console.log(`generated ${PROTOCOL_TARGET}`);
}
