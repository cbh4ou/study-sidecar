import { describe, expect, test } from "bun:test";
import { redact } from "./redact.ts";

describe("redaction", () => {
	test("replaces credentials without touching benign text", () => {
		const text = `${"api_key=private"} token: value secret=hidden password: pass authorization: Bearer header-value bearer loose-value sk-abcdefghijk 0123456789abcdef0123456789abcdef`;
		const result = redact(text);
		expect(result).not.toContain("private");
		expect(result).not.toContain("value");
		expect(result).not.toContain("hidden");
		expect(result).not.toContain("password: pass");
		expect(result).not.toContain("header-value");
		expect(result).not.toContain("loose-value");
		expect(result).not.toContain("abcdefghijk");
		expect(result).not.toContain("0123456789abcdef0123456789abcdef");
		expect(result).toContain("api_key=***");
		expect(result).toContain("authorization:***");
		expect(result).toContain("bearer ***");
		expect(result).toContain("sk-***");
		expect(result).toContain("***");
	});

	test("keeps assignment keys visible and redacts values case-insensitively", () => {
		expect(redact("API_KEY: abc123secret")).toBe("API_KEY:***");
		expect(redact("export MY_TOKEN='round-trip'")).toBe("export MY_TOKEN=***");
		expect(redact("token=hunter2")).toBe("token=***");
	});

	test("leaves benign text and short hex untouched", () => {
		expect(redact("Explain the parser architecture.")).toBe(
			"Explain the parser architecture.",
		);
		expect(redact("sha256 of 0123456789abcdef0123456789abcdef")).toContain(
			"***",
		);
		expect(redact("offset 0x1F and color fafafa")).toBe(
			"offset 0x1F and color fafafa",
		);
	});
});

describe("extended redaction coverage", () => {
	test("redacts AWS keys, GitHub tokens, JWTs, PEM blocks and cookies", () => {
		const pem =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const text = [
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
			"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureparthere",
			pem,
			"Cookie: sessionid=topsecretvalue",
		].join("\n");
		const result = redact(text);
		expect(result).not.toContain("wJalrXUtnFEMI");
		expect(result).not.toContain("ghp_abcdefghijklmnop");
		expect(result).not.toContain("eyJzdWIi");
		expect(result).not.toContain("MIIEowIBAAKCAQEA");
		expect(result).not.toContain("topsecretvalue");
		expect(result).toContain("AWS_SECRET_ACCESS_KEY=***");
		expect(result).toContain("gh*_***");
		expect(result).toContain("***jwt***");
		expect(result).toContain("PRIVATE KEY-----***");
		expect(result).toContain("Cookie:***");
	});

	test("leaves benign prose untouched", () => {
		expect(redact("The token bucket refills every second.")).toBe(
			"The token bucket refills every second.",
		);
	});
});

test("redacts underscore-joined credential keys, quoted JSON, and URL userinfo", () => {
	expect(redact("MY_SERVICE_PASSWORD=hunter2")).toBe("MY_SERVICE_PASSWORD=***");
	expect(redact('"authorization": "Basic dXNlcjpwYXNz"')).toBe(
		'"authorization:***',
	);
	expect(redact("connect to postgres://admin:s3cret@db.internal:5432/x")).toBe(
		"connect to postgres://***@db.internal:5432/x",
	);
	expect(redact("export SF_TOKEN=abc123")).toBe("export SF_TOKEN=***");
});
