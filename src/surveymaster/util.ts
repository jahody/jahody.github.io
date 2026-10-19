// Small numeric and formatting helpers that match Python's statistics module and f-strings,
// so ported metrics and prompt text come out the same as in survey6-classification.

/** Python's round(x, n). Exact .5 ties round up here instead of to even; parity checks allow for that. */
export const round = (x: number, n = 0) => {
  const f = 10 ** n;
  return Math.round(x * f) / f;
};

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Sample standard deviation (statistics.stdev). */
export const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
};

/** f"{x:.{d}f}" */
export const fx = (x: number, d: number) => x.toFixed(d);
/** f"{x:.{d}%}" */
export const pct = (x: number, d: number) => `${(x * 100).toFixed(d)}%`;

/** Python's str.ljust / rjust for the coverage table in refine prompts. */
export const ljust = (s: string | number, w: number) => String(s).padEnd(w);
export const rjust = (s: string | number, w: number) => String(s).padStart(w);

/** Python-style json.dumps(x, indent=2). */
export const dumps = (x: unknown) => JSON.stringify(x, null, 2);

/** Ordered counter (collections.Counter) keyed by string. */
export class Counter {
  readonly map = new Map<string, number>();
  add(key: string, n = 1) {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
  }
  get(key: string) {
    return this.map.get(key) ?? 0;
  }
  values() {
    return [...this.map.values()];
  }
  /** Highest count, first-inserted wins ties (Counter.most_common(1)[0]). */
  top(): [string, number] | undefined {
    let best: [string, number] | undefined;
    for (const [k, v] of this.map) if (!best || v > best[1]) best = [k, v];
    return best;
  }
}

/** Python's sorted() for strings (code-point order). */
export const sortStr = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** itertools.combinations(xs, 2) */
export function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

/** "nvidia/nemotron-3-super:free" → "nemotron-3-super_free" (slugify_model). */
export const slugifyModel = (model: string) => (model.split('/').pop() ?? model).replace(/[<>:"/\\|?*]/g, '_');
