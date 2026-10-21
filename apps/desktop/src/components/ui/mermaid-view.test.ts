import { expect, test } from "bun:test";
import { MermaidView } from "./mermaid-view";

test("exports a Mermaid view component without requiring a DOM", () => {
	expect(typeof MermaidView).toBe("function");
});
