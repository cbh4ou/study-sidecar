const RECEIPT_TOOLS: Record<string, true> = {
	read: true,
	view: true,
	grep: true,
	search: true,
	glob: true,
	findfiles: true,
	ls: true,
	find: true,
	rg: true,
};
const SIGNAL =
	/traceback|error|exception|failed|failure|fatal|panic|assert|passed|\bok\b|skipped|warning|loss\s*=|accuracy|acc\s*=|\bf1\b|precision|recall|epoch\s+\d+|lr\s*=|rmse|auc/i;
const ANTIPATTERNS: Array<[RegExp, string]> = [
	[
		/except[\s\S]{0,80}:\s*pass/,
		"silent exception swallowing (`except: pass`)",
	],
	[
		/train_test_split\([^)]*shuffle\s*=\s*True/,
		"possible data leakage: shuffled split on ordered/timestamped data",
	],
	[
		/(SELECT .*FROM .*\+.*)|(\.query\(\s*f?["'].*\+)/,
		"unindexed/injectable query: string-concatenated SQL",
	],
	[
		/except\s+Exception\s*:\s*\n\s*continue/,
		"bare exception swallowed in loop",
	],
];

export function fileReceipt(text: string): string {
	const lines = text.split(/\r?\n/);
	const nonempty = lines.filter((line) => line.trim()).length;
	const first =
		lines
			.find((line) => line.trim())
			?.trim()
			.slice(0, 120) ?? "";
	return `[receipt] ${nonempty} lines; first: ${first}`;
}

export function bashTail(text: string, tailLines = 35): string {
	const lines = text.split(/\r?\n/);
	const kept = lines
		.slice(-tailLines)
		.map((line) => (SIGNAL.test(line) ? `⚠ ${line}` : line));
	const prefix =
		lines.length > tailLines
			? `[tail ${kept.length}/${lines.length} lines]\n`
			: "";
	return prefix + kept.join("\n");
}

export function diffExcerpt(text: string, maxLines = 40): string {
	const lines = text.split(/\r?\n/);
	const candidates = lines.some((line) => line.startsWith("@@"))
		? lines.filter(
				(line) =>
					line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"),
			)
		: lines;
	const suffix =
		candidates.length > maxLines
			? `\n… (+${candidates.length - maxLines} more${candidates === lines ? "" : " diff"} lines)`
			: "";
	return candidates.slice(0, maxLines).join("\n") + suffix;
}

export function sieveToolResult(toolName: string, text: string): string {
	const name = toolName.toLowerCase();
	if (RECEIPT_TOOLS[name]) return fileReceipt(text);
	if (["bash", "shell", "terminal", "bashshell"].includes(name))
		return bashTail(text);
	if (["write", "writefile", "edit", "strreplace", "applypatch"].includes(name))
		return diffExcerpt(text);
	return text.slice(0, 2000);
}

export function detectAntipatterns(text: string): string[] {
	return ANTIPATTERNS.filter(([pattern]) => pattern.test(text)).map(
		([, label]) => label,
	);
}
