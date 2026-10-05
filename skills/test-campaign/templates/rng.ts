/**
 * Seeded randomness shared by node:test, Vitest and k6 — keep this file free of
 * imports and platform APIs so every runtime can load it.
 *
 *   const r = rng(hashSeed(runId, vu, iter, slug));
 *   r.pick(options); r.chance(0.1); r.int(1, 10);
 */
export interface Rng {
  next(): number; // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

/** mulberry32 — tiny, fast, good enough for test data. */
export function rng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    chance: (p) => next() < p,
  };
}

/** FNV-1a over the joined parts: a stable seed from (run, actor, entity, step). */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
