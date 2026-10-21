/** Shared warmup + median timing helper for performance assertions. */
export async function medianMs(
	samples: number,
	warmup: number,
	run: () => unknown | Promise<unknown>,
): Promise<{ median: number; worst: number }> {
	for (let index = 0; index < warmup; index += 1) await run();
	const times: number[] = [];
	for (let index = 0; index < samples; index += 1) {
		const started = performance.now();
		await run();
		times.push(performance.now() - started);
	}
	times.sort((left, right) => left - right);
	const middle = times.length >> 1;
	return {
		median:
			times.length % 2
				? times[middle]
				: (times[middle - 1] + times[middle]) / 2,
		worst: times[times.length - 1],
	};
}
