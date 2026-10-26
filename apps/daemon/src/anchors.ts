import { resolve } from "node:path";
import type { DaemonContext, Feature } from "./feature.ts";
import type { Learn } from "./learn/service.ts";
import type { SourceRef } from "./protocol.ts";

/** Confirmation is the sole path from a suggested anchor to durable lesson state. */
export function createAnchorFeature(context: DaemonContext): Feature {
	let pending: { anchor: SourceRef; preview: string } | undefined;
	return {
		name: "anchors",
		async onClientMessage(message) {
			if (message.type === "anchor_pin") {
				const candidates = context
					.events()
					.filter((event) => event.file_path || event.diff)
					.slice(-12);
				const latest = candidates.at(-1);
				if (!latest) {
					context.broadcast({
						type: "error",
						message: "No recent code anchor. Add a source in Classroom.",
					});
					return true;
				}
				const ids = candidates.map((_, i) => String(i));
				const decision = await context.ports.decide.decide(
					"anchor_pick",
					candidates.map((event, i) => `${i}: ${event.headline}`).join("\n"),
					ids,
					{
						localOnly: context.services.privacy?.isLocalOnly(
							context.watchedPath(),
						),
					},
				);
				const picked = candidates[Number(decision.choice)] ?? latest;
				const session = context.services.sessions?.bound();
				const anchor: SourceRef = picked.file_path
					? {
							kind: "file",
							path: resolve(
								context.session()?.cwd ?? process.cwd(),
								picked.file_path,
							),
						}
					: {
							kind: "session",
							harness: session?.harness ?? "auto",
							sessionId:
								session?.sessionId ?? context.session()?.id ?? "session",
							file: session?.path ?? context.watchedPath(),
						};
				pending = { anchor, preview: picked.headline.slice(0, 200) };
				context.broadcast({ type: "anchor_suggest", ...pending });
				return true;
			}
			if (message.type !== "anchor_confirm") return false;
			const chosen = pending;
			pending = undefined;
			if (!message.accept || !chosen) return true;
			const learn = context.services.learn as Learn | undefined;
			if (!learn) throw new Error("Learning service unavailable");
			const active = learn.activeLessonId();
			if (active) await learn.addSource(active, chosen.anchor);
			else
				await learn.createLesson({
					goal: chosen.preview,
					anchors: [chosen.anchor],
					sessionPath: context.watchedPath() || undefined,
				});
			return true;
		},
	};
}
