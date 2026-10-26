import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, type StoredSettings } from "../settings.ts";
import { FAKE_WEB_RESULTS, FakeWeb } from "./web-fake.ts";
import { htmlToText, WebProvider } from "./web-provider.ts";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function settings(web: StoredSettings["web"]): { value: StoredSettings } {
	return { value: { ...structuredClone(DEFAULT_SETTINGS), web } };
}

type Captured = { url: string; init?: RequestInit };

describe("WebProvider", () => {
	test("configured reflects settings at call time", () => {
		const store = settings({ provider: "none" });
		const web = new WebProvider({ settings: store });
		expect(web.configured).toBe(false);
		store.value.web = { provider: "brave", apiKey: "b" };
		expect(web.configured).toBe(true);
	});

	test("brave search sends a redacted query (T2)", async () => {
		const requests: Captured[] = [];
		const web = new WebProvider({
			settings: settings({ provider: "brave", apiKey: "brave-key" }),
			fetchImpl: async (url, init) => {
				requests.push({ url: String(url), init });
				return Response.json({
					web: {
						results: [
							{
								title: "<strong>Acks</strong>",
								url: "https://a.example/acks",
								description: "about &amp; acks",
							},
						],
					},
				});
			},
		});
		const results = await web.search(`pika ack timeout ${SECRET}`, {
			limit: 3,
		});
		expect(results).toEqual([
			{ title: "Acks", url: "https://a.example/acks", snippet: "about & acks" },
		]);
		const url = new URL(requests[0]?.url ?? "");
		expect(url.origin + url.pathname).toBe(
			"https://api.search.brave.com/res/v1/web/search",
		);
		expect(url.searchParams.get("q")).toContain("gh*_***");
		expect(requests[0]?.url).not.toContain("abcdefghijklmnop");
		expect(
			new Headers(requests[0]?.init?.headers).get("X-Subscription-Token"),
		).toBe("brave-key");
	});

	test("tavily search posts api_key and a redacted query (T2)", async () => {
		const requests: Captured[] = [];
		const web = new WebProvider({
			settings: settings({ provider: "tavily", apiKey: "tv-key" }),
			fetchImpl: async (url, init) => {
				requests.push({ url: String(url), init });
				return Response.json({
					results: [{ title: "T", url: "https://t.example", content: "c" }],
				});
			},
		});
		const results = await web.search(`password=hunter2 rabbitmq prefetch`);
		expect(results[0]?.url).toBe("https://t.example");
		expect(requests[0]?.url).toBe("https://api.tavily.com/search");
		const body = JSON.parse(String(requests[0]?.init?.body));
		expect(body.api_key).toBe("tv-key");
		expect(body.query).toBe("password=*** rabbitmq prefetch");
	});

	test("unconfigured search throws", async () => {
		const web = new WebProvider({ settings: settings({ provider: "none" }) });
		await expect(web.search("x")).rejects.toThrow("not configured");
	});

	test("fetch is https only and strips html", async () => {
		const web = new WebProvider({
			settings: settings({ provider: "none" }),
			fetchImpl: async () =>
				new Response(
					"<html><head><title>Acks &amp; you</title><style>p{}</style></head><body><nav>menu</nav><script>alert(1)</script><p>Hello   <b>world</b></p><p>Two</p></body></html>",
					{ headers: { "content-type": "text/html" } },
				),
		});
		await expect(web.fetch("http://insecure.example")).rejects.toThrow("https");
		const page = await web.fetch("https://docs.example/acks", { maxChars: 8 });
		expect(page.title).toBe("Acks & you");
		expect(page.text).toBe("Hello wo");
	});

	test("fetch caps the body at 2 MB", async () => {
		const big = "a".repeat(3 * 1024 * 1024);
		const web = new WebProvider({
			settings: settings({ provider: "none" }),
			fetchImpl: async () =>
				new Response(big, { headers: { "content-type": "text/plain" } }),
		});
		const page = await web.fetch("https://big.example", {
			maxChars: 10 * 1024 * 1024,
		});
		expect(page.text.length).toBe(2 * 1024 * 1024);
	});

	test("htmlToText drops chrome and collapses whitespace", () => {
		const { text } = htmlToText(
			"<header>top</header><div>a\n\n   b</div><footer>bottom</footer><!-- c -->",
		);
		expect(text).toBe("a\nb");
	});
});

describe("FakeWeb", () => {
	test("returns 3 canned https results and a page", async () => {
		const web = new FakeWeb();
		const results = await web.search("channel ack");
		expect(results).toHaveLength(3);
		for (const result of results)
			expect(result.url.startsWith("https://")).toBe(true);
		const page = await web.fetch(FAKE_WEB_RESULTS[0]?.url ?? "");
		expect(page.text).toContain("acknowledgement");
	});
});

test("web fetch redacts URL credentials at its own cloud boundary", async () => {
	let sent = "";
	const provider = new WebProvider({
		settings: settings({ provider: "none" }),
		fetchImpl: async (url) => {
			sent = String(url);
			return new Response("public docs");
		},
	});
	await provider.fetch("https://docs.example/page?api_key=SUPERSECRETVALUE123");
	expect(sent).not.toContain("SUPERSECRETVALUE123");
	expect(sent).toContain("api_key=***");
});

test("fetch refuses loopback, private, and link-local hosts", async () => {
	const { isPrivateHost } = await import("./web-provider.ts");
	for (const host of [
		"localhost",
		"127.0.0.1",
		"10.1.2.3",
		"172.20.0.1",
		"192.168.1.10",
		"169.254.169.254",
		"[::1]",
		"fd00::1",
		"intranet",
		"printer.local",
	])
		expect(isPrivateHost(host)).toBe(true);
	for (const host of ["example.com", "8.8.8.8", "docs.typesafe.ai"])
		expect(isPrivateHost(host)).toBe(false);
});
