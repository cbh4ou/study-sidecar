import { describe, expect, test } from "bun:test";
import { encodePcm16Base64, resampleMono } from "./audio";

describe("voice audio frames", () => {
	test("encodes s16le PCM as base64", () => {
		expect(encodePcm16Base64(new Float32Array([-1, 0, 1]))).toBe("AIAAAP9/");
	});

	test("resamples a mono frame to 16 kHz", () => {
		const frame = resampleMono(new Float32Array([0, 1, 0, -1]), 8_000);
		expect(frame).toHaveLength(8);
		expect(frame[0]).toBe(0);
		expect(frame[2]).toBeCloseTo(1);
		expect(frame[6]).toBeCloseTo(-1);
	});
});
