import table from "../fixtures/decide.json";
import {
	certain,
	type DecideOptions,
	type DecidePort,
	type DecideTask,
	type Decision,
} from "../ports/decide.ts";
import { RulesDecide } from "./decide-rules.ts";

export type FakeDecideTable = Partial<
	Record<DecideTask, Array<{ match: string; choice: string }>>
>;

export const DEFAULT_FAKE_DECIDE_TABLE = table as FakeDecideTable;

/** Table-driven Decide for fake mode: first substring match wins, else rules. */
export class FakeDecide implements DecidePort {
	readonly #rules = new RulesDecide();
	constructor(
		private readonly table: FakeDecideTable = DEFAULT_FAKE_DECIDE_TABLE,
	) {}

	async decide<T extends string>(
		task: DecideTask,
		input: string,
		options: readonly T[],
		opts?: DecideOptions,
	): Promise<Decision<T>> {
		const text = input.toLowerCase();
		for (const row of this.table[task] ?? []) {
			if (!text.includes(row.match.toLowerCase())) continue;
			const choice = options.find((option) => option === row.choice);
			if (choice !== undefined) return certain(choice, options, "fake");
		}
		const fallback = await this.#rules.decide(task, input, options, opts);
		return { ...fallback, adapter: "fake" };
	}
}
