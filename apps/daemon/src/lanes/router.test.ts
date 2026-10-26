import { describe, expect, test } from "bun:test";
import { certain, type DecidePort, type DecideTask } from "../ports/decide.ts";
import { ruleIntent, ruleLane } from "./intent-rules.ts";
import { route } from "./router.ts";

/** Rules-only DecidePort: the composition's final fallback. */
function rulesDecide(calls: DecideTask[] = []): DecidePort {
	return {
		async decide(task, input, options, opts) {
			calls.push(task);
			void opts;
			let choice: string | undefined;
			if (task === "intent") choice = ruleIntent(input) ?? "question";
			else if (task === "lane") choice = ruleLane(input);
			const picked = (options as readonly string[]).includes(choice ?? "")
				? (choice as (typeof options)[number])
				: options[0];
			if (picked === undefined) throw new Error("no options");
			return certain(picked, options, "rules");
		},
	};
}

describe("intent routing (T9)", () => {
	test("stop -> cancel, bridge back, question", async () => {
		const decide = rulesDecide();
		expect((await route("stop", decide)).intent).toBe("cancel");
		expect((await route("send that back to Claude", decide)).intent).toBe(
			"bridge_back",
		);
		const question = await route("why does the ack time out?", decide);
		expect(question.intent).toBe("question");
		expect(question.lane).toBe("fast_and_deep");
		expect(question.adapter).toBe("rules");
	});

	test("rule fast path skips Decide for intent; lane still consulted", async () => {
		const calls: DecideTask[] = [];
		await route("why does the ack time out?", rulesDecide(calls));
		expect(calls).toEqual(["lane"]);
		calls.length = 0;
		await route("stop", rulesDecide(calls));
		expect(calls).toEqual([]);
	});

	test("ambiguous text goes to Decide with localOnly and its adapter", async () => {
		const seen: Array<{ task: string; localOnly?: boolean }> = [];
		const decide: DecidePort = {
			async decide(task, _input, options, opts) {
				seen.push({ task, localOnly: opts?.localOnly });
				const choice = (
					task === "intent" ? "question" : "fast_only"
				) as (typeof options)[number];
				return certain(choice, options, "fake");
			},
		};
		const result = await route("channel acks", decide, { localOnly: true });
		expect(result).toMatchObject({
			intent: "question",
			lane: "fast_only",
			adapter: "fake",
		});
		expect(seen).toEqual([
			{ task: "intent", localOnly: true },
			{ task: "lane", localOnly: true },
		]);
	});

	test("web keywords pick needs_web; decide errors fall back", async () => {
		const failing: DecidePort = {
			async decide() {
				throw new Error("down");
			},
		};
		expect(
			(await route("search the latest papers on acks", failing)).lane,
		).toBe("needs_web");
		const fallback = await route("channel acks", failing);
		expect(fallback.intent).toBe("question");
		expect(fallback.lane).toBe("fast_and_deep");
	});
});
