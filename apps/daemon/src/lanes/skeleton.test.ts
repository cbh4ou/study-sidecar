import { describe, expect, test } from "bun:test";
import { anchorSkeleton } from "./skeleton.ts";

describe("anchorSkeleton", () => {
	test("python keeps defs, classes, decorators; drops bodies", () => {
		const source = `import os

@dataclass
class Channel:
    capacity: int = 8

    def send(self, message: str) -> None:
        if self.full():
            raise RuntimeError("full")
        self.queue.append(message)

    async def ack(self, id: int) -> bool:
        return True

def helper():
    x = 1
    return x
`;
		const skeleton = anchorSkeleton(source, "chan.py");
		expect(skeleton.split("\n")).toEqual([
			"chan.py",
			"@dataclass",
			"class Channel:",
			"    def send(self, message: str) -> None:",
			"    async def ack(self, id: int) -> bool:",
			"def helper():",
		]);
	});

	test("typescript keeps declarations and signatures only", () => {
		const source = `import { x } from "y";

export interface Ack {
  id: string;
}
export type Id = string;
export const timeout = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms));
};
const LIMIT = 4;
export class Channel {
  #queue: string[] = [];
  async send(message: string): Promise<void> {
    if (this.#queue.length > LIMIT) {
      throw new Error("full");
    }
    this.#queue.push(message);
  }
}
export default function main() {
  return 1;
}
`;
		const skeleton = anchorSkeleton(source, "chan.ts");
		expect(skeleton.split("\n")).toEqual([
			"chan.ts",
			"export interface Ack",
			"export type Id = string;",
			"export const timeout = (ms: number): Promise<void> => …",
			"export class Channel",
			"  async send(message: string): Promise<void>",
			"export default function main()",
		]);
		expect(skeleton).not.toContain("throw");
		expect(skeleton).not.toContain("LIMIT = 4");
	});

	test("rust and go keep fn/impl/struct and func/type lines", () => {
		const rust = anchorSkeleton(
			"#[derive(Debug)]\npub struct Ack { id: u32 }\nimpl Ack {\n    pub fn new(id: u32) -> Self {\n        Self { id }\n    }\n}\n",
			"ack.rs",
		);
		expect(rust).toContain("#[derive(Debug)]");
		expect(rust).toContain("pub struct Ack");
		expect(rust).toContain("impl Ack");
		expect(rust).toContain("    pub fn new(id: u32) -> Self");
		expect(rust).not.toContain("Self { id }");
		const go = anchorSkeleton(
			"package chan\n\ntype Ack struct {\n\tID int\n}\n\nfunc (a *Ack) Send(m string) error {\n\treturn nil\n}\n",
			"ack.go",
		);
		expect(go.split("\n")).toEqual([
			"ack.go",
			"package chan",
			"type Ack struct",
			"func (a *Ack) Send(m string) error",
		]);
	});

	test("non-code falls back to headings, then first lines", () => {
		expect(anchorSkeleton("# Title\ntext\n## Part\nmore", "notes.md")).toBe(
			"notes.md\n# Title\n## Part",
		);
		expect(anchorSkeleton("line one\n\nline two", "log.txt")).toBe(
			"log.txt\nline one\nline two",
		);
	});
});
