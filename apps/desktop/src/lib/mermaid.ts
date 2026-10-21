const mermaidFence = /^(`{3,})mermaid\b[^\r\n]*\r?\n([\s\S]*?)^\1[ \t]*$/gim;

/** Extracts trimmed Mermaid fenced blocks without touching other code fences. */
export function extractMermaid(text: string): string[] {
	return Array.from(text.matchAll(mermaidFence), (match) => match[2].trim());
}

/** Removes Mermaid fenced blocks while preserving all other display text. */
export function stripMermaid(text: string): string {
	return text.replace(mermaidFence, "");
}

/** Lists the flowchart nodes named by common Mermaid square, round, and diamond syntax. */
export function nodeTargets(
	diagram: string,
): Array<{ id: string; label: string }> {
	const nodes = new Map<string, { id: string; label: string }>();
	const add = (id: string, label?: string) => {
		if (!nodes.has(id) || label !== undefined) {
			nodes.set(id, { id, label: label ?? id });
		}
	};

	for (const line of diagram.split(/\r?\n/)) {
		if (/^\s*(?:flowchart|graph)\b/i.test(line)) continue;

		for (const match of line.matchAll(
			/\b([A-Za-z_][\w-]*)\s*(?:\[\s*([^\]]*?)\s*\]|\(\s*([^)]*?)\s*\)|\{\s*([^}]*?)\s*\})/g,
		)) {
			const label = (match[2] ?? match[3] ?? match[4] ?? "").trim();
			add(match[1], label.replace(/^(["'])(.*)\1$/, "$2"));
		}

		for (const match of line.matchAll(
			/\b([A-Za-z_][\w-]*)\s*(?=(?:--+|==+|-\.->))/g,
		)) {
			add(match[1]);
		}
		for (const match of line.matchAll(
			/(?:--+>|==+>|-\.->)\s*([A-Za-z_][\w-]*)\b/g,
		)) {
			add(match[1]);
		}
	}

	return [...nodes.values()];
}
