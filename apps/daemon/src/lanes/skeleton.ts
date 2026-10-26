/**
 * Anchor skeletons for the Context Packet (spec Section 8, section 3):
 * symbols and signatures only, never full bodies. Line-based on purpose:
 * cheap, deterministic, and good enough for py/ts/js/rs/go.
 */

type Language = "py" | "ts" | "rs" | "go";

const EXTENSIONS: Record<string, Language> = {
	py: "py",
	pyi: "py",
	ts: "ts",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	rs: "rs",
	go: "go",
};

const CONTROL = /^\s*(if|else|for|while|switch|catch|return|do|try|with)\b/;

const PATTERNS: Record<Language, RegExp[]> = {
	py: [/^\s*(async\s+)?def\s+\w+/, /^\s*class\s+\w+/, /^\s*@[\w.]+/],
	ts: [
		/^\s*@[\w.]+/,
		/^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace|module)\s+[\w$]/,
		/^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(function\b|(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>)/,
		/^\s*export\s+(\*|\{|default\b|const\b|let\b|var\b)/,
		// Class members: `name(args) {`, with optional modifiers.
		/^\s+(public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+)*#?[\w$]+\s*(<[^>]*>)?\([^)]*\)\s*(:\s*[^{=]+)?\{\s*$/,
	],
	rs: [
		/^\s*#!?\[/,
		/^\s*(pub(\([^)]*\))?\s+)?(const\s+)?(async\s+)?(unsafe\s+)?(extern\s+"[^"]*"\s+)?fn\s+\w+/,
		/^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|union|mod|type)\s+\w+/,
		/^\s*(unsafe\s+)?impl\b/,
		/^\s*(pub(\([^)]*\))?\s+)?(const|static)\s+[A-Z_][A-Z0-9_]*\s*:/,
	],
	go: [
		/^func\b/,
		/^type\s+\w+/,
		/^\s*type\s+\w+\s+(struct|interface)\b/,
		/^package\s+\w+/,
	],
};

const MAX_LINES = 200;

function languageOf(path: string): Language | undefined {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSIONS[ext];
}

/** Reduce a kept line to its signature: drop opening braces and arrow bodies. */
function signature(line: string, language: Language): string {
	let kept = line.replace(/\s+$/, "");
	if (language === "ts") {
		const arrow = kept.indexOf("=>");
		if (arrow >= 0 && /^\s*(export\s+)?(const|let|var)\s/.test(kept))
			kept = `${kept.slice(0, arrow + 2)} …`;
	}
	if (language === "py") return kept;
	return kept
		.replace(/\s*\{\s*(\}\s*)?;?$/, "")
		.replace(/\s*\{[^{}]*\}\s*$/, "");
}

function fallback(text: string, path: string): string {
	const lines = text.split(/\r?\n/);
	const headings = lines.filter((line) => /^#{1,6}\s+\S/.test(line));
	const kept = headings.length
		? headings
		: lines.filter((line) => line.trim()).slice(0, 10);
	return [path, ...kept.slice(0, MAX_LINES).map((line) => line.trimEnd())]
		.join("\n")
		.trim();
}

/** Signatures/declarations of a source file, prefixed by its path. */
export function anchorSkeleton(text: string, path: string): string {
	const language = languageOf(path);
	if (!language) return fallback(text, path);
	const patterns = PATTERNS[language];
	const kept: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || CONTROL.test(line)) continue;
		if (!patterns.some((pattern) => pattern.test(line))) continue;
		kept.push(signature(line, language));
		if (kept.length >= MAX_LINES) break;
	}
	if (!kept.length) return fallback(text, path);
	return [path, ...kept].join("\n");
}
