import { createHash, randomBytes } from "node:crypto";

/** Minimal chain shape simplify works over. */
export type ChainLike = { id: string; premises: string[]; conclusion: string };

/** "arg_" + sha1(sorted premises + "=>" + conclusion), 16 hex chars. */
export function chainId(premises: string[], conclusion: string): string {
	const key = `${[...new Set(premises)].sort().join(",")}=>${conclusion}`;
	return `arg_${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "n_" + ulid-like id: 10 chars of time, 16 chars of randomness (Crockford base32). */
export function propositionId(now = Date.now()): string {
	let time = "";
	let t = Math.max(0, Math.floor(now));
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = randomBytes(16);
	let rand = "";
	for (const byte of bytes) rand += CROCKFORD[byte % 32];
	return `n_${time}${rand}`;
}

/** sha1 of a message text (coverage key). */
export function messageHash(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

/**
 * Forward closure of `start` under `chains`: repeatedly add a chain's
 * conclusion once every premise is in the set.
 */
function closure(start: Iterable<string>, chains: ChainLike[]): Set<string> {
	const known = new Set(start);
	let grew = true;
	while (grew) {
		grew = false;
		for (const chain of chains) {
			if (known.has(chain.conclusion)) continue;
			if (chain.premises.every((p) => known.has(p))) {
				known.add(chain.conclusion);
				grew = true;
			}
		}
	}
	return known;
}

/**
 * Redundancy pruning, per conclusion. Chains are considered in order
 * (`preferred` first, then fewer premises, then id) and a chain is dropped
 * when an already-kept chain for the same conclusion makes it redundant:
 *
 * - identical (sorted premises, conclusion): dedupe;
 * - its premise set is a strict superset of the kept chain's premises;
 * - its premises, plus everything they entail through chains for OTHER
 *   conclusions, cover the kept chain's premises (so it is the composition
 *   of existing arguments). Example: [A,B]=>X, [X,C]=>Y make [A,B,C]=>Y
 *   redundant, because {A,B,C} entails X and so covers {X,C}.
 *
 * The superset rule is a special case of the coverage rule; both are named
 * for clarity. `context` adds chains that count for entailment but are not
 * themselves candidates (the rest of the graph).
 */
export function simplifyChains<T extends ChainLike>(
	chains: T[],
	opts: { preferred?: Set<string>; context?: ChainLike[] } = {},
): T[] {
	const preferred = opts.preferred ?? new Set<string>();
	const unique = new Map<string, T>();
	for (const chain of chains) {
		const key = chainId(chain.premises, chain.conclusion);
		const prior = unique.get(key);
		if (!prior || (preferred.has(chain.id) && !preferred.has(prior.id)))
			unique.set(key, chain);
	}
	const all = [...unique.values()];
	const universe: ChainLike[] = [...all, ...(opts.context ?? [])];

	const ordered = [...all].sort((a, b) => {
		const pa = preferred.has(a.id) ? 0 : 1;
		const pb = preferred.has(b.id) ? 0 : 1;
		if (pa !== pb) return pa - pb;
		if (a.premises.length !== b.premises.length)
			return a.premises.length - b.premises.length;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const kept: T[] = [];
	const keptBy = new Map<string, T[]>();
	for (const chain of ordered) {
		const rivals = keptBy.get(chain.conclusion) ?? [];
		const others = universe.filter((c) => c.conclusion !== chain.conclusion);
		const premises = new Set(chain.premises);
		const reach = closure(premises, others);
		const redundant = rivals.some((rival) => {
			const strictSuperset =
				rival.premises.length < premises.size &&
				rival.premises.every((p) => premises.has(p));
			return strictSuperset || rival.premises.every((p) => reach.has(p));
		});
		if (redundant) continue;
		kept.push(chain);
		keptBy.set(chain.conclusion, [...rivals, chain]);
	}
	// Keep caller order for stable output.
	const keep = new Set(kept);
	return all.filter((chain) => keep.has(chain));
}
