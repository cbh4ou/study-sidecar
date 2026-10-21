import { describe, expect, test } from "bun:test";
import { extractMermaid, nodeTargets, stripMermaid } from "./mermaid";

describe("Mermaid fences", () => {
	test("extracts basic and multiple Mermaid blocks", () => {
		expect(
			extractMermaid(
				"Before\n```mermaid\nflowchart TD\n\tA --> B\n```\nMiddle\n```mermaid title\ngraph LR\n\tC --> D\n```\nAfter",
			),
		).toEqual(["flowchart TD\n\tA --> B", "graph LR\n\tC --> D"]);
	});

	test("ignores absent and unclosed Mermaid fences while accepting four backticks", () => {
		expect(extractMermaid("```typescript\nconst node = 1;\n```")).toEqual([]);
		expect(
			extractMermaid("````mermaid\nflowchart TD\n\tA --> B\n````"),
		).toEqual(["flowchart TD\n\tA --> B"]);
		expect(extractMermaid("```mermaid\nflowchart TD\n\tA --> B")).toEqual([]);
	});

	test("strips Mermaid blocks without changing other fenced code", () => {
		const text =
			"Shown\n```mermaid\nflowchart TD\n\tA --> B\n```\n```typescript\nconst node = 1;\n```\nMore";
		expect(stripMermaid(text)).toBe(
			"Shown\n\n```typescript\nconst node = 1;\n```\nMore",
		);
	});
});

test("finds flowchart node ids and labels", () => {
	expect(
		nodeTargets(
			"flowchart TD\nA[Square node] --> B(Round node)\nB --> C{Diamond node}\nD --> E",
		),
	).toEqual([
		{ id: "A", label: "Square node" },
		{ id: "B", label: "Round node" },
		{ id: "C", label: "Diamond node" },
		{ id: "D", label: "D" },
		{ id: "E", label: "E" },
	]);
	expect(nodeTargets('graph LR\nA["Quoted label"]')).toEqual([
		{ id: "A", label: "Quoted label" },
	]);
});
