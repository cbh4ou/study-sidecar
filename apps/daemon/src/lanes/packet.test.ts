import { describe, expect, test } from "bun:test";
import { FakeClock } from "../ports/clock.ts";
import type { LessonDetail, Proposition } from "../protocol.ts";
import type { Services } from "../services.ts";
import {
	buildContextPacket,
	estimateTokens,
	PACKET_CAP,
	type PacketInput,
	PacketWarmer,
	SECTION_BUDGETS,
} from "./packet.ts";

/** Mulberry32: tiny seeded PRNG so T1 is deterministic. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = "channel ack producer consumer buffer retry timeout queue the a of"
	.split(" ");

function words(rand: () => number, max: number): string {
	const n = 1 + Math.floor(rand() * max);
	return Array.from(
		{ length: n },
		() => WORDS[Math.floor(rand() * WORDS.length)],
	).join(" ");
}

function list(rand: () => number, maxItems: number, maxWords: number) {
	return Array.from({ length: Math.floor(rand() * maxItems) }, () =>
		words(rand, maxWords),
	);
}

const MODE = {
	name: "spotter",
	description: "Watches quietly",
	prompt: "Stay terse.",
};
const RULES = "# Tutor rules\n- One concept per turn.";

function randomInput(rand: () => number): PacketInput {
	return {
		mode: MODE,
		tutorRules: RULES,
		learner: list(rand, 30, 40),
		anchors: Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
			path: `src/file${i}.ts`,
			text: Array.from(
				{ length: Math.floor(rand() * 300) },
				(_, j) => `export function fn${j}(a: number): number {\n  return a;\n}`,
			).join("\n"),
		})),
		receipts: list(rand, 60, 60),
		memory: list(rand, 8, 120),
		lesson: list(rand, 5, 40),
		question: words(rand, rand() < 0.1 ? 4000 : 40),
	};
}

describe("context packet (T1)", () => {
	test("never exceeds 4000 tokens across 50 seeded randomized inputs", () => {
		const rand = prng(42);
		for (let i = 0; i < 50; i++) {
			const packet = buildContextPacket(randomInput(rand));
			expect(packet.tokens).toBeLessThanOrEqual(PACKET_CAP);
			expect(estimateTokens(packet.system) + estimateTokens(packet.user)).toBe(
				packet.tokens,
			);
			for (const [name, budget] of Object.entries(SECTION_BUDGETS))
				expect(
					packet.sections[name as keyof typeof SECTION_BUDGETS].tokens,
				).toBeLessThanOrEqual(budget);
		}
	});

	test("trims receipts first, then memory, then anchors", () => {
		const full: PacketInput = {
			mode: MODE,
			tutorRules: RULES,
			learner: ["x".repeat(1000)],
			anchors: [
				{
					path: "a.ts",
					text: Array.from(
						{ length: 200 },
						(_, j) => `export function f${j}(value: string): string {`,
					).join("\n"),
				},
			],
			receipts: Array.from({ length: 40 }, (_, i) => `receipt ${i} ${"r".repeat(60)}`),
			memory: Array.from({ length: 5 }, (_, i) => `memory ${i} ${"m".repeat(300)}`),
			lesson: ["lesson ".repeat(150)],
			question: "",
		};
		const budgetsFull = (question: string) =>
			buildContextPacket({ ...full, question });
		const base = budgetsFull("why?");
		expect(base.sections.receipts.items).toBeGreaterThan(0);

		// Grow the question until each trimmable section empties in order.
		let emptied: string[] = [];
		for (let size = 0; size <= 16000; size += 200) {
			const packet = budgetsFull(`q ${"w".repeat(size)}`);
			expect(packet.tokens).toBeLessThanOrEqual(PACKET_CAP);
			const now = (["receipts", "memory", "anchors"] as const).filter(
				(name) => packet.sections[name].items === 0,
			);
			for (const name of now) if (!emptied.includes(name)) emptied.push(name);
			// Memory never shrinks while receipts still has items, etc.
			if (packet.sections.receipts.items > 0) {
				expect(packet.sections.memory.tokens).toBe(base.sections.memory.tokens);
				expect(packet.sections.anchors.tokens).toBe(base.sections.anchors.tokens);
			}
			if (packet.sections.memory.items > 0)
				expect(packet.sections.anchors.tokens).toBe(base.sections.anchors.tokens);
		}
		emptied = emptied.slice(0, 3);
		expect(emptied).toEqual(["receipts", "memory", "anchors"]);
	});

	test("drops the oldest receipts first", () => {
		const receipts = Array.from({ length: 30 }, (_, i) => `r${i} ${"x".repeat(200)}`);
		const packet = buildContextPacket({
			mode: MODE,
			tutorRules: RULES,
			receipts,
			question: "why?",
		});
		expect(packet.user).toContain("r29 ");
		expect(packet.user).not.toContain("r0 ");
	});

	test("system prefix is byte-stable and redaction applies to every section", () => {
		const secret = "api_key=sk-abcdefghijklmnop";
		const a = buildContextPacket({
			mode: MODE,
			tutorRules: `${RULES}\n${secret}`,
			receipts: [`ran with ${secret}`],
			learner: [`token: ghp_${"a".repeat(30)}`],
			memory: ["Authorization: Bearer abc.def"],
			lesson: [`password=${"p".repeat(10)}`],
			anchors: [{ path: "notes.md", text: `# Heading ${secret}` }],
			question: `what about ${secret}?`,
		});
		const b = buildContextPacket({
			mode: MODE,
			tutorRules: `${RULES}\n${secret}`,
			question: "something else entirely",
		});
		expect(a.system).toBe(b.system);
		const all = `${a.system}\n${a.user}`;
		expect(all).not.toContain("sk-abcdefghijklmnop");
		expect(all).not.toContain(`ghp_${"a".repeat(30)}`);
		expect(all).not.toContain("abc.def");
		expect(all).not.toContain("p".repeat(10));
		expect(all).toContain("***");
	});
});

describe("PacketWarmer", () => {
	const proposition: Proposition = {
		id: "p1",
		name: "Channel ack",
		statement: "An ack confirms delivery.",
		sources: [],
		createdAt: "2026-01-01T00:00:00Z",
		birthSource: "test",
	};
	const lesson = {
		id: "L1",
		title: "Acks",
		goal: "understand acks",
		anchors: [{ kind: "file", path: "/repo/a.py" }],
		phase: "teach",
		createdAt: "",
		updatedAt: "",
		messages: [],
		questions: [{ kind: "ask", id: "q1", prompt: "What is an ack?" }],
		answers: {},
		planNodes: [{ id: "n1", label: "Ack basics", status: "current" }],
		queuedGaps: [],
		sources: [],
	} as LessonDetail;

	function services(receipts: string[]): Services {
		return {
			graph: {
				recent: async () => [proposition],
			} as unknown as Services["graph"],
			learn: {
				activeLessonId: () => "L1",
				lesson: async () => lesson,
				dueCards: async () => [],
			} as unknown as Services["learn"],
			sessions: {
				bound: () => undefined,
				receipts: () => receipts,
				searchAcross: () => [{ path: "/s/other.jsonl", receipt: "other receipt" }],
			},
		};
	}

	test("debounces rebuilds by 250 ms and builds from services + recall", async () => {
		const clock = new FakeClock();
		const receipts = ["first receipt"];
		let warmed = 0;
		const warmer = new PacketWarmer({
			services: services(receipts),
			clock,
			mode: () => MODE,
			tutorRules: RULES,
			recall: (q) => [`memory for ${q}`],
			readFile: async () => "def ack(msg):\n    return True\n",
			onWarm: () => warmed++,
		});
		warmer.schedule();
		clock.advance(100);
		warmer.schedule();
		clock.advance(200);
		expect(warmed).toBe(0);
		clock.advance(60);
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(warmed).toBe(1);
		expect(warmer.base?.receipts).toEqual(["first receipt"]);

		const packet = await warmer.build("what is an ack?");
		expect(packet.user).toContain("Channel ack: An ack confirms delivery.");
		expect(packet.user).toContain("def ack(msg):");
		expect(packet.user).not.toContain("return True");
		expect(packet.user).toContain("Current plan node: Ack basics");
		expect(packet.user).toContain("Last question: What is an ack?");
		expect(packet.user).toContain("memory for what is an ack?");
		expect(packet.user).toContain("first receipt");

		const across = await warmer.build("q", { allSessions: true });
		expect(across.user).toContain("other receipt");
		expect(across.user).not.toContain("first receipt");
	});
});
