import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonContext, Feature } from "../feature.ts";
import { type DeepLane, FakeDeepLane, HarnessDeepLane } from "./deep.ts";
import { PacketWarmer, type RecallFn } from "./packet.ts";
import { TurnRunner } from "./turn.ts";

export type LanesFeatureOptions = {
	/** Recalled-memory hook (section 5): e.g. OKFStore.query -> previews. */
	recall?: RecallFn;
	/** Override the deep lane (tests). Defaults to Fake or Harness by mode. */
	deep?: DeepLane;
	/** Override TUTOR.md contents (tests). */
	tutorRules?: string;
	/** Read-only anchor reader (tests). */
	readFile?: (path: string) => Promise<string>;
	newTurnId?: () => string;
};

const TUTOR_FALLBACK =
	"You are Study Sidecar, a voice-first tutor. One concept per turn. Use the learner's own names. Never read code aloud.";

export function loadTutorRules(): string {
	try {
		return readFileSync(join(import.meta.dir, "TUTOR.md"), "utf8");
	} catch {
		return TUTOR_FALLBACK;
	}
}

/**
 * Voice/typed turns (spec Section 7): owns `question`, `ptt_start`,
 * `ptt_stop`, and `interrupt`, so index.ts's legacy question path is skipped.
 */
export function createLanesFeature(
	context: DaemonContext,
	options: LanesFeatureOptions = {},
): Feature {
	const { services, ports } = context;
	const packets = new PacketWarmer({
		services,
		clock: ports.clock,
		mode: () => {
			const mode = context.tutor.activeMode;
			return {
				name: mode.name,
				description: mode.description,
				prompt: mode.prompt,
			};
		},
		tutorRules: options.tutorRules ?? loadTutorRules(),
		...(options.recall ? { recall: options.recall } : {}),
		...(options.readFile ? { readFile: options.readFile } : {}),
	});
	const deep: DeepLane =
		options.deep ??
		(context.fake
			? new FakeDeepLane({
					broadcast: context.broadcast,
					services,
					mode: () => context.tutor.activeMode.name,
				})
			: new HarnessDeepLane({
					tutor: context.tutor,
					broadcast: context.broadcast,
					web: ports.web,
				}));
	const runner = new TurnRunner({
		broadcast: context.broadcast,
		llm: ports.llm,
		decide: ports.decide,
		deep,
		packets,
		services,
		clock: ports.clock,
		activity: context.activity,
		latestSteering: () => context.tutor.latestSteering,
		boundSessionPath: () => context.watchedPath() || undefined,
		...(options.newTurnId ? { newTurnId: options.newTurnId } : {}),
	});

	return {
		name: "lanes",
		start() {
			packets.schedule();
		},
		stop() {
			packets.cancel();
			runner.interrupt();
		},
		onEvent() {
			packets.schedule();
		},
		async onClientMessage(message) {
			switch (message.type) {
				case "ptt_start":
					runner.pttStart();
					return true;
				case "ptt_stop":
					runner.pttStop();
					return true;
				case "interrupt":
					runner.interrupt();
					return true;
				case "question":
					// Do not block the socket loop: the turn streams on its own.
					void runner.question(message);
					return true;
				default:
					return false;
			}
		},
	};
}
