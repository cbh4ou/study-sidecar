import { describe, expect, test } from "bun:test";
import { medianMs } from "../timing.ts";
import {
	bashTail,
	detectAntipatterns,
	diffExcerpt,
	fileReceipt,
	sieveToolResult,
} from "./tier0.ts";

describe("Tier-0 sieve", () => {
	test("compresses read output into a receipt", () => {
		expect(fileReceipt("\nfirst line\nsecond line\n")).toBe(
			"[receipt] 2 lines; first: first line",
		);
		expect(sieveToolResult("read", "one\ntwo")).toBe(
			"[receipt] 2 lines; first: one",
		);
	});

	test("compresses a 200KB Read dump with median under 5ms", async () => {
		const dump = "source line with routine tool output\n".repeat(6_500);
		// Warmup 5 iterations, then the median of 20 runs absorbs scheduler
		// spikes; the 20ms ceiling catches regressions without flaking.
		const { median, worst } = await medianMs(20, 5, () =>
			sieveToolResult("Read", dump),
		);
		expect(median).toBeLessThan(5);
		expect(worst).toBeLessThan(20);
	});

	test("tails bash and marks signal lines", () => {
		const output = Array.from({ length: 40 }, (_, index) =>
			index === 39 ? "tests passed" : `line ${index}`,
		).join("\n");
		expect(bashTail(output)).toContain("[tail 35/40 lines]");
		expect(bashTail(output)).toContain("⚠ tests passed");
	});

	test("keeps only unified diff hunks", () => {
		expect(diffExcerpt(" context\n@@ -1 +1 @@\n-old\n+new\n context")).toBe(
			"@@ -1 +1 @@\n-old\n+new",
		);
	});

	test("finds guardrail antipatterns", () => {
		expect(detectAntipatterns("try:\n  work()\nexcept:\n  pass\n")).toContain(
			"silent exception swallowing (`except: pass`)",
		);
	});
});
