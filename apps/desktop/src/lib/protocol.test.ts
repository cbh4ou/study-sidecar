import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	PROTOCOL_SOURCE,
	PROTOCOL_TARGET,
	renderProtocolCopy,
} from "../../../../scripts/gen-protocol.ts";

describe("protocol drift gate", () => {
	test("desktop protocol copy is byte-identical to the generated output", () => {
		const generated = renderProtocolCopy(readFileSync(PROTOCOL_SOURCE, "utf8"));
		expect(readFileSync(PROTOCOL_TARGET, "utf8")).toBe(generated);
	});
});
