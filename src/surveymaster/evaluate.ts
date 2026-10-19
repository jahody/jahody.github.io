// Stage 4, the port of 4_evaluate.py: eight consistency and coverage metrics, pass/fail verdicts,
// and verdict-driven taxonomy refinement. Output keys match consistency_metrics.json so results
// can be compared one-to-one with the Python.

import { activeResults } from './classify';
import { callJson, type CallOptions } from './llm';
import { TAXONOMY_SCHEMA_EXAMPLE } from './taxonomize';
import type { Consensus, ModelResults, Project, Settings, TaxNode, Taxonomy } from './types';
import { Counter, dumps, fx, ljust, mean, median, pairs, pct, rjust, round, sortStr, stdev, sum } from './util';

type Pred = { chapter: string; confidence: number };
/** model → paper → taxonomy → ranked chapters */
export type Predictions = Record<string, Record<string, Record<string, Pred[]>>>;

// Thresholds from config.yaml (refinement.thresholds and friends).
export const THRESHOLDS = {
  min_fleiss_kappa: 0.4,
  min_mean_pairwise_agreement: 0.5,
  min_pairwise_kappa: 0.2,
  max_weak_consensus_fraction: 0.3,
  min_confidence_agreement_r: 0.3,
  max_outlier_deviation: 0.4,
  min_unanimous_rate: 0.3,
  max_gini: 0.5,
  max_cramers_v: 0.7,
};
export const DEAD_THRESHOLD = 0;
export const FAT_MULTIPLIER = 2.5;
export const MIN_COVERAGE_ENTROPY = 0.7;

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

function nameToChapter(items: TaxNode[], mapping: Record<string, string>) {
  for (const item of items) {
    if (item.name !== undefined && item.chapter !== undefined) mapping[item.name] = String(item.chapter);
    if (item.items) nameToChapter(item.items, mapping);
  }
}

/** Python int(): whole numbers and numeric strings, else 50. */
function toInt(v: unknown): number {
  if (v === undefined || v === null) return 100;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return 50;
}

export function extractNormalizedPredictions(allModelResults: Record<string, ModelResults>, taxonomies: Taxonomy[]): Predictions {
  const lookup: Record<string, Record<string, string>> = {};
  for (const t of taxonomies) nameToChapter(t.items, (lookup[t.name] = {}));
  const predictions: Predictions = {};
  for (const [model, results] of Object.entries(allModelResults)) {
    predictions[model] = {};
    for (const [paper, paperData] of Object.entries(results)) {
      predictions[model][paper] = {};
      for (const [tax, r] of Object.entries(paperData)) {
        if (r.error) continue;
        let chapters: any[] = r.chapters ?? [];
        if (!chapters.length && r.chapter !== undefined) {
          const ch = r.chapter;
          chapters = Array.isArray(ch)
            ? ch.map((c) => ({ chapter: c, confidence: Math.floor(100 / Math.max(ch.length, 1)) }))
            : [{ chapter: ch, confidence: 100 }];
        }
        predictions[model][paper][tax] = chapters.map((e) => {
          const raw = e && typeof e === 'object' ? String(e.chapter) : String(e);
          const conf = e && typeof e === 'object' ? toInt(e.confidence) : Math.floor(100 / Math.max(chapters.length, 1));
          return { chapter: lookup[tax]?.[raw] ?? raw, confidence: conf };
        });
      }
    }
  }
  return predictions;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

export function cohensKappa(a: string[], b: string[]): number {
  const n = a.length;
  if (n === 0) return 0;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const labels = new Set([...a, ...b]);
  let pe = 0;
  for (const l of labels) pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

export function fleissKappa(ratings: number[][], nRaters: number): number {
  const nItems = ratings.length;
  if (nItems === 0 || nRaters <= 1) return 0;
  const nCats = ratings[0].length;
  const pItems = ratings.map((row) => (sum(row.map((x) => x * x)) - nRaters) / (nRaters * (nRaters - 1)));
  const pBar = sum(pItems) / nItems;
  let peBar = 0;
  for (let j = 0; j < nCats; j++) {
    const pj = sum(ratings.map((row) => row[j])) / (nItems * nRaters);
    peBar += pj * pj;
  }
  if (peBar >= 1) return 1;
  return (pBar - peBar) / (1 - peBar);
}

export function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  const cov = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(sum(ys.map((y) => (y - my) ** 2)));
  if (sx === 0 || sy === 0) return 0;
  return cov / (sx * sy);
}

function universe(predictions: Predictions) {
  const models = sortStr(Object.keys(predictions));
  const papers = new Set<string>();
  const taxonomies = new Set<string>();
  for (const m of models)
    for (const [p, taxes] of Object.entries(predictions[m])) {
      papers.add(p);
      for (const t of Object.keys(taxes)) taxonomies.add(t);
    }
  return { models, papers: sortStr(papers), taxonomies: sortStr(taxonomies) };
}

const top1 = (predictions: Predictions, m: string, paper: string, tax: string) => predictions[m]?.[paper]?.[tax];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function computePairwiseAgreement(predictions: Predictions) {
  const { models, papers, taxonomies } = universe(predictions);
  const pairResults: Record<string, any> = {};
  for (const [ma, mb] of pairs(models)) {
    const la: string[] = [];
    const lb: string[] = [];
    const perTax = new Map<string, { a: string[]; b: string[] }>();
    for (const paper of papers)
      for (const tax of taxonomies) {
        const a = top1(predictions, ma, paper, tax);
        const b = top1(predictions, mb, paper, tax);
        if (!a?.length || !b?.length) continue;
        la.push(a[0].chapter);
        lb.push(b[0].chapter);
        if (!perTax.has(tax)) perTax.set(tax, { a: [], b: [] });
        perTax.get(tax)!.a.push(a[0].chapter);
        perTax.get(tax)!.b.push(b[0].chapter);
      }
    const n = la.length;
    const agree = la.filter((x, i) => x === lb[i]).length;
    const key = `${ma} vs ${mb}`;
    pairResults[key] = { agreement_rate: n ? round(agree / n, 4) : 0, cohens_kappa: round(cohensKappa(la, lb), 4), n_compared: n, per_taxonomy: {} };
    for (const tax of sortStr(perTax.keys())) {
      const { a, b } = perTax.get(tax)!;
      const tAgree = a.filter((x, i) => x === b[i]).length;
      pairResults[key].per_taxonomy[tax] = { agreement_rate: a.length ? round(tAgree / a.length, 4) : 0, cohens_kappa: round(cohensKappa(a, b), 4), n: a.length };
    }
  }
  const matrix = models.map((mi, i) =>
    models.map((mj, j) => (i === j ? 1 : pairResults[i < j ? `${mi} vs ${mj}` : `${mj} vs ${mi}`].agreement_rate)),
  );
  return { pairs: pairResults, matrix, model_names: models };
}

export function computeFleissKappa(predictions: Predictions) {
  const { models, papers, taxonomies } = universe(predictions);
  const nRaters = models.length;
  const cats = new Set<string>();
  for (const paper of papers)
    for (const tax of taxonomies)
      for (const m of models) {
        const chs = top1(predictions, m, paper, tax);
        if (chs?.length) cats.add(chs[0].chapter);
      }
  const catList = sortStr(cats);
  const catIdx = new Map(catList.map((c, i) => [c, i]));

  const perTax: Record<string, number> = {};
  const all: number[][] = [];
  for (const tax of taxonomies) {
    const taxRatings: number[][] = [];
    for (const paper of papers) {
      const row = new Array(catList.length).fill(0);
      let raters = 0;
      for (const m of models) {
        const chs = top1(predictions, m, paper, tax);
        if (chs?.length && catIdx.has(chs[0].chapter)) {
          row[catIdx.get(chs[0].chapter)!]++;
          raters++;
        }
      }
      if (raters === nRaters) {
        taxRatings.push(row);
        all.push(row);
      }
    }
    if (taxRatings.length) perTax[tax] = round(fleissKappa(taxRatings, nRaters), 4);
  }
  return { overall: all.length ? round(fleissKappa(all, nRaters), 4) : 0, per_taxonomy: perTax, n_raters: nRaters, n_items_overall: all.length };
}

function marginStats(vals: number[]) {
  if (!vals.length) return {};
  return {
    mean: round(mean(vals), 1),
    median: round(median(vals), 1),
    std: vals.length > 1 ? round(stdev(vals), 1) : 0,
    min: Math.min(...vals),
    max: Math.max(...vals),
    weak_count: vals.filter((v) => v < 20).length,
    strong_count: vals.filter((v) => v >= 20).length,
    n: vals.length,
  };
}

export function computeConsensusStrength(consensus: Consensus) {
  const margins: number[] = [];
  const perTax = new Map<string, number[]>();
  const perPaper: Record<string, Record<string, any>> = {};
  for (const paper of sortStr(Object.keys(consensus))) {
    perPaper[paper] = {};
    for (const [tax, r] of Object.entries(consensus[paper])) {
      const sorted = r.votes.map(([, v]) => v).sort((a, b) => b - a);
      const winner = sorted[0] ?? 0;
      const margin = winner - (sorted[1] ?? 0);
      margins.push(margin);
      if (!perTax.has(tax)) perTax.set(tax, []);
      perTax.get(tax)!.push(margin);
      perPaper[paper][tax] = { margin, winner: r.chapter ?? '', winner_score: winner };
    }
  }
  return {
    overall: marginStats(margins) as ReturnType<typeof marginStats> & Record<string, number>,
    per_taxonomy: Object.fromEntries(sortStr(perTax.keys()).map((t) => [t, marginStats(perTax.get(t)!)])) as Record<string, any>,
    per_paper: perPaper,
  };
}

export function computeConfidenceAgreement(predictions: Predictions) {
  const { models, papers, taxonomies } = universe(predictions);
  const points: { paper: string; taxonomy: string; agreement: number; mean_confidence: number }[] = [];
  for (const paper of papers)
    for (const tax of taxonomies) {
      const tops: string[] = [];
      const confs: number[] = [];
      for (const m of models) {
        const chs = top1(predictions, m, paper, tax);
        if (chs?.length) {
          tops.push(chs[0].chapter);
          confs.push(chs[0].confidence);
        }
      }
      if (tops.length < 2) continue;
      const c = new Counter();
      tops.forEach((t) => c.add(t));
      points.push({ paper, taxonomy: tax, agreement: round(c.top()![1] / tops.length, 4), mean_confidence: round(mean(confs), 1) });
    }
  const r = points.length ? pearsonR(points.map((p) => p.agreement), points.map((p) => p.mean_confidence)) : 0;
  return { pearson_r: round(r, 4), n_points: points.length, points };
}

export function computeModelDeviation(predictions: Predictions, consensus: Consensus) {
  const models = sortStr(Object.keys(predictions));
  const stats: Record<string, any> = {};
  for (const m of models) {
    let deviations = 0;
    let total = 0;
    const perTax = new Map<string, { deviations: number; total: number }>();
    for (const [paper, taxes] of Object.entries(predictions[m]))
      for (const [tax, chs] of Object.entries(taxes)) {
        const winner = consensus[paper]?.[tax]?.chapter;
        if (winner === undefined || !chs.length) continue;
        total++;
        if (!perTax.has(tax)) perTax.set(tax, { deviations: 0, total: 0 });
        const t = perTax.get(tax)!;
        t.total++;
        if (chs[0].chapter !== winner) {
          deviations++;
          t.deviations++;
        }
      }
    stats[m] = {
      deviation_rate: total ? round(deviations / total, 4) : 0,
      deviations,
      total,
      per_taxonomy: Object.fromEntries(
        sortStr(perTax.keys()).map((t) => {
          const v = perTax.get(t)!;
          return [t, { deviation_rate: v.total ? round(v.deviations / v.total, 4) : 0, ...v }];
        }),
      ),
    };
  }
  let outlier: string | null = null;
  for (const m of models) if (outlier === null || stats[m].deviation_rate > stats[outlier].deviation_rate) outlier = m;
  return { models: stats, outlier_model: outlier };
}

export function computeTaxonomyDifficulty(predictions: Predictions) {
  const { models, papers, taxonomies } = universe(predictions);
  const taxStats: Record<string, any> = {};
  for (const tax of taxonomies) {
    let unanimous = 0;
    let majority = 0;
    let total = 0;
    const confidences: number[] = [];
    const used = new Set<string>();
    const counts = new Counter();
    for (const paper of papers) {
      const tops: string[] = [];
      for (const m of models) {
        const chs = top1(predictions, m, paper, tax);
        if (chs?.length) {
          tops.push(chs[0].chapter);
          confidences.push(chs[0].confidence);
          used.add(chs[0].chapter);
          counts.add(chs[0].chapter);
        }
      }
      if (tops.length < 2) continue;
      total++;
      const c = new Counter();
      tops.forEach((t) => c.add(t));
      const topCount = c.top()![1];
      if (topCount === tops.length) unanimous++;
      else if (topCount > tops.length / 2) majority++;
    }
    const totalAssignments = sum(counts.values());
    let entropy = 0;
    if (totalAssignments > 0)
      for (const cnt of counts.values()) {
        const p = cnt / totalAssignments;
        if (p > 0) entropy -= p * Math.log2(p);
      }
    taxStats[tax] = {
      unanimous_rate: total ? round(unanimous / total, 4) : 0,
      majority_rate: total ? round((unanimous + majority) / total, 4) : 0,
      mean_top1_confidence: confidences.length ? round(mean(confidences), 1) : 0,
      unique_chapters_used: used.size,
      entropy: round(entropy, 3),
      n_papers: total,
    };
  }
  const ranked = Object.entries(taxStats).sort((a, b) => b[1].unanimous_rate - a[1].unanimous_rate);
  return { taxonomies: taxStats, easiest: ranked[0]?.[0] ?? null, hardest: ranked.at(-1)?.[0] ?? null };
}

export function collectLeafChapters(items: TaxNode[], result = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.items?.length) collectLeafChapters(item.items, result);
    else result.add(String(item.chapter || item.name || ''));
  }
  return result;
}

export function collectAllChapterNames(items: TaxNode[], result: Record<string, string> = {}): Record<string, string> {
  for (const item of items) {
    result[String(item.chapter || item.name || '')] = item.name ?? '';
    if (item.items?.length) collectAllChapterNames(item.items, result);
  }
  return result;
}

export function gini(counts: number[]): number {
  const n = counts.length;
  const total = sum(counts);
  if (n === 0 || total === 0) return 0;
  const vals = [...counts].sort((a, b) => a - b);
  return sum(vals.map((v, i) => (2 * (i + 1) - n - 1) * v)) / (n * total);
}

export function normalizedEntropy(counts: number[]): number {
  const n = counts.length;
  const total = sum(counts);
  if (n <= 1 || total === 0) return 0;
  const h = -sum(counts.filter((c) => c > 0).map((c) => (c / total) * Math.log2(c / total)));
  return h / Math.log2(n);
}

/** Papers per consensus chapter for one taxonomy (_load_consensus_coverage). */
export function consensusCoverage(consensus: Consensus, taxName: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const paper of Object.values(consensus)) {
    const ch = paper[taxName]?.chapter;
    if (ch) counts.set(String(ch), (counts.get(String(ch)) ?? 0) + 1);
  }
  return counts;
}

export function computeCoverageAnalysis(consensus: Consensus, taxonomies: Taxonomy[]) {
  const nPapers = Object.keys(consensus).length;
  const result: Record<string, any> = {};
  for (const t of [...taxonomies].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const leaves = collectLeafChapters(t.items);
    const names = collectAllChapterNames(t.items);
    const counts = consensusCoverage(consensus, t.name);
    const leafCounts = new Map([...leaves].map((ch) => [ch, counts.get(ch) ?? 0]));
    const vals = [...leafCounts.values()];
    const meanC = vals.length ? mean(vals) : 0;
    const fatThreshold = meanC * FAT_MULTIPLIER;
    const dead = sortStr([...leafCounts].filter(([, c]) => c === 0).map(([ch]) => ch));
    const fat = sortStr([...leafCounts].filter(([, c]) => c > fatThreshold && leaves.size > 1).map(([ch]) => ch));
    result[t.name] = {
      n_leaves: leaves.size,
      n_papers: nPapers,
      mean_papers_per_leaf: round(meanC, 1),
      dead_count: dead.length,
      fat_count: fat.length,
      gini: round(gini(vals), 3),
      normalized_entropy: round(normalizedEntropy(vals), 3),
      dead_leaves: dead,
      fat_leaves: fat,
      per_leaf: Object.fromEntries(
        sortStr(leaves).map((ch) => [ch, { name: names[ch] ?? ch, count: leafCounts.get(ch)!, dead: dead.includes(ch), fat: fat.includes(ch) }]),
      ),
    };
  }
  return result;
}

export function cramersV(table: number[][]): number {
  const nRows = table.length;
  const nCols = table[0]?.length ?? 0;
  if (nRows < 2 || nCols < 2) return 0;
  const n = sum(table.map((r) => sum(r)));
  if (n === 0) return 0;
  const rowSums = table.map((r) => sum(r));
  const colSums = table[0].map((_, c) => sum(table.map((r) => r[c])));
  let chi2 = 0;
  for (let r = 0; r < nRows; r++)
    for (let c = 0; c < nCols; c++) {
      const expected = (rowSums[r] * colSums[c]) / n;
      if (expected > 0) chi2 += (table[r][c] - expected) ** 2 / expected;
    }
  const minDim = Math.min(nRows - 1, nCols - 1);
  return minDim === 0 ? 0 : Math.sqrt(chi2 / (n * minDim));
}

export function computeTaxonomyIndependence(consensus: Consensus) {
  const assignments: Record<string, Record<string, string>> = {};
  const taxSet = new Set<string>();
  for (const [paper, taxes] of Object.entries(consensus)) {
    assignments[paper] = {};
    for (const [tax, r] of Object.entries(taxes))
      if (r.chapter) {
        assignments[paper][tax] = String(r.chapter);
        taxSet.add(tax);
      }
  }
  const taxList = sortStr(taxSet);
  if (taxList.length < 2) return { pairs: {}, matrix: [] as number[][], taxonomy_names: taxList, redundant_pairs: [] as string[] };

  const pairsOut: Record<string, { cramers_v: number; redundant: boolean }> = {};
  const redundant: string[] = [];
  const matrix = taxList.map(() => taxList.map(() => 0));
  taxList.forEach((a, i) => {
    matrix[i][i] = 1;
    taxList.forEach((b, j) => {
      if (j <= i) return;
      const chA = sortStr(new Set(Object.values(assignments).map((p) => p[a]).filter(Boolean)));
      const chB = sortStr(new Set(Object.values(assignments).map((p) => p[b]).filter(Boolean)));
      const ai = new Map(chA.map((c, k) => [c, k]));
      const bi = new Map(chB.map((c, k) => [c, k]));
      const table = chA.map(() => chB.map(() => 0));
      for (const p of Object.values(assignments)) if (ai.has(p[a]) && bi.has(p[b])) table[ai.get(p[a])!][bi.get(p[b])!]++;
      const v = round(cramersV(table), 4);
      const key = `${a} vs ${b}`;
      pairsOut[key] = { cramers_v: v, redundant: v > 0.7 };
      matrix[i][j] = matrix[j][i] = v;
      if (v > 0.7) redundant.push(key);
    });
  });
  return { pairs: pairsOut, matrix, taxonomy_names: taxList, redundant_pairs: redundant };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface Verdict {
  id: string;
  name: string;
  group: string;
  passed: boolean;
  value: number | null;
  threshold: number | Record<string, number>;
  detail: string;
  action: string | null;
  failing_taxonomies: string[];
  redundant_pairs?: string[];
}

export function computeMetricVerdicts(metrics: Metrics): Record<string, Verdict> {
  const th = THRESHOLDS;
  const v: Record<string, Verdict> = {};

  const fk = metrics.fleiss_kappa;
  const minFk = th.min_fleiss_kappa;
  const fkOk = fk.overall >= minFk;
  v.m1 = {
    id: 'm1', name: "Fleiss' Kappa", group: 'Inter-Model Agreement', passed: fkOk, value: round(fk.overall, 4), threshold: minFk,
    detail: fkOk ? `Overall kappa ${fx(fk.overall, 3)} >= ${minFk}` : `Overall kappa ${fx(fk.overall, 3)} < ${minFk}`,
    action: fkOk ? null : 'Clarify category boundaries and descriptions — models interpret categories inconsistently',
    failing_taxonomies: Object.entries(fk.per_taxonomy).filter(([, k]) => k < minFk).map(([t]) => t),
  };

  const pa = metrics.pairwise_agreement;
  const minPa = th.min_mean_pairwise_agreement;
  const rates = Object.values(pa.pairs).map((p: any) => p.agreement_rate as number);
  const meanRate = rates.length ? mean(rates) : 0;
  const lowKappa = Object.entries(pa.pairs).filter(([, p]: any) => p.cohens_kappa < th.min_pairwise_kappa).map(([k]) => k);
  const perTaxRates = new Map<string, number[]>();
  for (const p of Object.values(pa.pairs) as any[])
    for (const [tax, info] of Object.entries(p.per_taxonomy) as any) {
      if (!perTaxRates.has(tax)) perTaxRates.set(tax, []);
      perTaxRates.get(tax)!.push(info.agreement_rate);
    }
  const paOk = meanRate >= minPa && !lowKappa.length;
  v.m2 = {
    id: 'm2', name: 'Pairwise Agreement', group: 'Inter-Model Agreement', passed: paOk, value: round(meanRate, 4), threshold: minPa,
    detail: meanRate >= minPa ? `Mean agreement ${pct(meanRate, 1)} >= ${pct(minPa, 0)}` : `Mean agreement ${pct(meanRate, 1)} < ${pct(minPa, 0)}`,
    action: paOk ? null : 'Sharpen distinctions between overlapping categories' + (lowKappa.length ? ` (low kappa pairs: ${lowKappa.join(', ')})` : ''),
    failing_taxonomies: [...perTaxRates].filter(([, rs]) => mean(rs) < minPa).map(([t]) => t),
  };

  const cs = metrics.consensus_strength;
  const maxWeak = th.max_weak_consensus_fraction;
  const weakFrac = cs.overall.n ? cs.overall.weak_count / cs.overall.n : 0;
  const csOk = weakFrac <= maxWeak;
  v.m3 = {
    id: 'm3', name: 'Consensus Strength', group: 'Consensus Quality', passed: csOk, value: round(weakFrac, 4), threshold: maxWeak,
    detail: csOk ? `Weak consensus ${pct(weakFrac, 0)} of items <= ${pct(maxWeak, 0)}` : `Weak consensus ${pct(weakFrac, 0)} of items > ${pct(maxWeak, 0)}`,
    action: csOk ? null : 'Merge or differentiate boundary categories — too many papers split between two choices',
    failing_taxonomies: Object.entries(cs.per_taxonomy)
      .filter(([, ts]: any) => ts.n > 0 && (ts.weak_count ?? 0) / ts.n > maxWeak)
      .map(([t]) => t),
  };

  const r = metrics.confidence_agreement.pearson_r;
  const minR = th.min_confidence_agreement_r;
  const rOk = Math.abs(r) >= minR;
  v.m4 = {
    id: 'm4', name: 'Confidence-Agreement Correlation', group: 'Consensus Quality', passed: rOk, value: round(r, 4), threshold: minR,
    detail: rOk ? `Pearson r = ${fx(r, 3)} (|r| >= ${minR})` : `Pearson r = ${fx(r, 3)} (|r| < ${minR})`,
    action: rOk ? null : 'Category descriptions may be misleading — models are confident but disagree',
    failing_taxonomies: [],
  };

  const md = metrics.model_deviation;
  const maxDev = th.max_outlier_deviation;
  const maxRate = Math.max(0, ...Object.values(md.models).map((s: any) => s.deviation_rate as number));
  const devOk = maxRate <= maxDev;
  v.m5 = {
    id: 'm5', name: 'Per-Model Deviation', group: 'Model Outliers', passed: devOk, value: round(maxRate, 4), threshold: maxDev,
    detail: devOk ? `Max deviation ${pct(maxRate, 1)} <= ${pct(maxDev, 0)}` : `Max deviation ${pct(maxRate, 1)} > ${pct(maxDev, 0)} (outlier: ${md.outlier_model})`,
    action: devOk ? null : 'Informational: consider excluding outlier model or investigate its disagreement patterns',
    failing_taxonomies: [],
  };

  const td = metrics.taxonomy_difficulty.taxonomies;
  const minUnan = th.min_unanimous_rate;
  const failing6 = Object.entries(td).filter(([, s]: any) => s.unanimous_rate < minUnan).map(([t]) => t);
  v.m6 = {
    id: 'm6', name: 'Taxonomy Difficulty', group: 'Taxonomy Clarity', passed: !failing6.length,
    value: Object.keys(td).length ? round(Math.min(...Object.values(td).map((s: any) => s.unanimous_rate)), 4) : 0, threshold: minUnan,
    detail: !failing6.length
      ? `All taxonomies have unanimous rate >= ${pct(minUnan, 0)}`
      : `${failing6.length} taxonomy(ies) below ${pct(minUnan, 0)} unanimous: ${failing6.join(', ')}`,
    action: failing6.length ? 'Taxonomy too fine-grained — consider merging similar leaf categories' : null,
    failing_taxonomies: failing6,
  };

  const issues: string[] = [];
  const failing7: string[] = [];
  for (const [tax, info] of Object.entries(metrics.coverage_analysis) as any) {
    let fail = false;
    if (info.dead_count > 0) (issues.push(`${tax}: ${info.dead_count} dead leaves`), (fail = true));
    if (info.gini > th.max_gini) (issues.push(`${tax}: gini ${fx(info.gini, 3)} > ${th.max_gini}`), (fail = true));
    if (info.normalized_entropy < MIN_COVERAGE_ENTROPY) (issues.push(`${tax}: entropy ${fx(info.normalized_entropy, 3)} < ${MIN_COVERAGE_ENTROPY}`), (fail = true));
    if (fail) failing7.push(tax);
  }
  v.m7 = {
    id: 'm7', name: 'Coverage Analysis', group: 'Structural Balance', passed: !issues.length, value: null,
    threshold: { max_gini: th.max_gini, min_entropy: MIN_COVERAGE_ENTROPY, dead_threshold: DEAD_THRESHOLD },
    detail: issues.length ? issues.join('; ') : 'All taxonomies structurally balanced',
    action: issues.length ? 'Rebalance: split overcrowded leaves, merge/replace empty ones' : null,
    failing_taxonomies: failing7,
  };

  const redundant = metrics.taxonomy_independence.redundant_pairs;
  v.m8 = {
    id: 'm8', name: 'Taxonomy Independence', group: 'Taxonomy Diversity', passed: !redundant.length, value: null, threshold: th.max_cramers_v,
    detail: redundant.length ? `Redundant pairs (V > ${th.max_cramers_v}): ${redundant.join(', ')}` : 'All taxonomy pairs are adequately independent',
    action: redundant.length ? 'Redundant taxonomies detected — consider merging or replacing one' : null,
    failing_taxonomies: [],
    redundant_pairs: redundant,
  };
  return v;
}

export function computeMetrics(project: Project) {
  const results = activeResults(project);
  const predictions = extractNormalizedPredictions(results, project.taxonomies);
  const metrics = {
    pairwise_agreement: computePairwiseAgreement(predictions),
    fleiss_kappa: computeFleissKappa(predictions),
    consensus_strength: computeConsensusStrength(project.consensus),
    confidence_agreement: computeConfidenceAgreement(predictions),
    model_deviation: computeModelDeviation(predictions, project.consensus),
    taxonomy_difficulty: computeTaxonomyDifficulty(predictions),
    metadata: {
      topic: project.topic,
      n_models: Object.keys(results).length,
      n_papers: new Set(Object.values(results).flatMap((r) => Object.keys(r))).size,
      models: sortStr(Object.keys(results)),
      taxonomies: sortStr(project.taxonomies.map((t) => t.name)),
    },
    coverage_analysis: computeCoverageAnalysis(project.consensus, project.taxonomies),
    taxonomy_independence: computeTaxonomyIndependence(project.consensus),
    verdicts: {} as Record<string, Verdict>,
  };
  metrics.verdicts = computeMetricVerdicts(metrics as Metrics);
  return metrics;
}

export type Metrics = ReturnType<typeof computeMetrics>;

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

export const REFINE_SYSTEM_BALANCE =
  'You are an expert research taxonomist. You will be given an existing taxonomy ' +
  'and coverage data showing how papers distributed across its categories. ' +
  'Restructure the taxonomy to fix balance issues while preserving the organizing principle. ' +
  'Respond with valid JSON only.';

export const REFINE_SYSTEM_BOUNDARIES =
  'You are an expert research taxonomist. You will be given an existing taxonomy ' +
  'and evidence that classification models disagree on category boundaries. ' +
  'Your task is to rewrite category descriptions, phrases, and hard_negatives to make ' +
  'boundaries unambiguous — without changing the overall structure. ' +
  'Respond with valid JSON only.';

export const REFINE_SYSTEM_REDUNDANCY =
  'You are an expert research taxonomist. You will be given two taxonomies that are ' +
  'statistically redundant (they classify papers nearly identically). ' +
  'Your task is to redesign one of them so it provides a genuinely different organizing perspective. ' +
  'Respond with valid JSON only.';

function refineStats(coverage: Map<string, number>, leaves: Set<string>, names: Record<string, string>, totalPapers: number) {
  const leafCounts = new Map([...leaves].map((ch) => [ch, coverage.get(ch) ?? 0]));
  const counts = [...leafCounts.values()];
  const meanCount = counts.length ? mean(counts) : 0;
  const dead = [...leafCounts].filter(([, c]) => c <= DEAD_THRESHOLD).map(([ch]) => ch);
  const fat = [...leafCounts].filter(([, c]) => c > meanCount * FAT_MULTIPLIER && leaves.size > 1).map(([ch]) => ch);
  return {
    n_leaves: leaves.size,
    total_papers: totalPapers,
    mean_papers_per_leaf: round(meanCount, 1),
    dead_count: dead.length,
    fat_count: fat.length,
    gini: round(gini(counts), 3),
    normalized_entropy: round(normalizedEntropy(counts), 3),
    per_leaf: Object.fromEntries(sortStr(leaves).map((ch) => [ch, { name: names[ch] ?? ch, count: leafCounts.get(ch)!, dead: dead.includes(ch), fat: fat.includes(ch) }])),
    dead_leaves: sortStr(dead),
    fat_leaves: sortStr(fat),
  };
}

const OUTPUT_INSTRUCTIONS = (taxonomyName: string) => `## Requirements
- Keep the same top-level organizing principle ("${taxonomyName}")
- Maintain 2-3 levels of hierarchy, targeting 5-15 leaf categories total
- Use snake_case for all category names
- Do NOT assign papers to categories
- Every leaf must have: name, chapter, description, phrases, hard_negative
- Chapter numbering: "1", "1.1", "1.1.1", "1.1(a)"

Single category schema example:
${TAXONOMY_SCHEMA_EXAMPLE}

Output a single JSON object:
{
  "perspective": "${taxonomyName}",
  "description": "1 sentence explaining this organizing angle.",
  "categories": [ ... ]
}`;

export function buildCoverageRefinePrompt(taxonomyName: string, taxonomyJson: TaxNode[], stats: ReturnType<typeof refineStats>): string {
  const n = stats.total_papers;
  const lines = Object.entries(stats.per_leaf).map(([ch, info]) => {
    const flags: string[] = [];
    if (info.dead) flags.push('DEAD');
    if (info.fat) flags.push(`FAT (${((info.count / n) * 100).toFixed(0)}% of papers)`);
    return `  ${ljust(ch, 8)}  ${ljust(info.name, 40)}  ${rjust(info.count, 3)} papers${flags.length ? '  <- ' + flags.join(', ') : ''}`;
  });
  const issues: string[] = [];
  if (stats.dead_count > 0) issues.push(`  - Dead categories (0 papers): ${stats.dead_leaves.map((ch) => `${ch} (${stats.per_leaf[ch].name})`).join(', ')}`);
  if (stats.fat_count > 0) issues.push(`  - Overcrowded categories: ${stats.fat_leaves.map((ch) => `${ch} (${stats.per_leaf[ch].name})`).join(', ')}`);
  const restructure = [
    ...stats.fat_leaves.map((ch) => `  - Split '${stats.per_leaf[ch].name}' (${ch}) into 2-3 more specific subcategories`),
    ...stats.dead_leaves.map((ch) => `  - Replace or merge '${stats.per_leaf[ch].name}' (${ch}) — it matched no papers`),
  ];
  if (!restructure.length) restructure.push('  - Redistribute categories more evenly');

  return `You are an expert research taxonomist. Below is the taxonomy "${taxonomyName}" and how ${n} papers distributed across its leaf categories.

## Current Taxonomy (JSON)
\`\`\`json
${dumps(taxonomyJson)}
\`\`\`

## Coverage Report (${n} papers, ${stats.n_leaves} leaf categories, mean ${fx(stats.mean_papers_per_leaf, 1)} papers/leaf)
${lines.join('\n')}

Balance metrics: Gini=${fx(stats.gini, 3)}, Normalized Entropy=${fx(stats.normalized_entropy, 3)}

## Issues Detected
${issues.length ? issues.join('\n') : '  None detected (refinement triggered by low entropy).'}

## Restructuring Instructions
${restructure.join('\n')}

${OUTPUT_INSTRUCTIONS(taxonomyName)}`;
}

export function buildBoundaryRefinePrompt(taxonomyName: string, taxonomyJson: TaxNode[], failing: string[], metrics: Metrics): string {
  const evidence: string[] = [];
  const fkTax = metrics.fleiss_kappa.per_taxonomy[taxonomyName];
  if (fkTax !== undefined) evidence.push(`  - Fleiss' kappa for this taxonomy: ${fx(fkTax, 3)}`);
  for (const [pair, data] of Object.entries(metrics.pairwise_agreement.pairs) as any) {
    const t = data.per_taxonomy?.[taxonomyName];
    if (t) evidence.push(`  - ${pair}: agreement=${pct(t.agreement_rate, 1)}, kappa=${fx(t.cohens_kappa, 3)} (n=${t.n})`);
  }
  const cs = metrics.consensus_strength.per_taxonomy[taxonomyName];
  if (cs && Object.keys(cs).length) evidence.push(`  - Consensus margin: mean=${fx(cs.mean ?? 0, 1)}, weak=${cs.weak_count ?? 0}/${cs.n ?? 0}`);
  const td = metrics.taxonomy_difficulty.taxonomies[taxonomyName];
  if (td) evidence.push(`  - Difficulty: unanimous=${pct(td.unanimous_rate, 0)}, majority=${pct(td.majority_rate, 0)}, entropy=${fx(td.entropy, 2)}`);

  const instructions: string[] = [];
  if (failing.includes('m1') || failing.includes('m2')) {
    instructions.push('- Rewrite descriptions to be more precise and mutually exclusive');
    instructions.push('- Add or improve hard_negative fields to explicitly state what does NOT belong');
    instructions.push('- Expand phrases lists with discriminating keywords');
  }
  if (failing.includes('m3')) instructions.push('- Categories that papers frequently split between should be merged or given sharper boundaries');
  if (failing.includes('m4')) instructions.push('- Descriptions may be misleading models into false confidence — rewrite for clarity');
  if (failing.includes('m6')) instructions.push('- Consider merging similar leaf categories to reduce granularity where models cannot agree');

  return `The taxonomy "${taxonomyName}" has boundary clarity issues — classification models disagree on where papers belong.

## Current Taxonomy (JSON)
\`\`\`json
${dumps(taxonomyJson)}
\`\`\`

## Agreement Evidence
Failing metrics: ${failing.map((m) => m.toUpperCase()).join(', ')}
${evidence.length ? evidence.join('\n') : '  (no per-taxonomy data)'}

## Instructions
Improve the taxonomy so that category boundaries are unambiguous. You may restructure if needed, but prioritize clarity over structural change.

${instructions.join('\n')}

${OUTPUT_INSTRUCTIONS(taxonomyName)}`;
}

export function buildRedundancyRefinePrompt(aName: string, aJson: TaxNode[], bName: string, bJson: TaxNode[], v: number): string {
  return `Two taxonomies classify papers nearly identically (Cramer's V = ${fx(v, 3)}, where >0.7 indicates redundancy).

## Taxonomy A: "${aName}"
\`\`\`json
${dumps(aJson)}
\`\`\`

## Taxonomy B: "${bName}"
\`\`\`json
${dumps(bJson)}
\`\`\`

## Instructions
Redesign taxonomy B ("${bName}") so it provides a genuinely different organizing perspective from taxonomy A. The new taxonomy should:
- Capture a different dimension of the research (e.g., if A is by method, B should be by application or by scale)
- Be orthogonal to A: a paper's category in A should NOT predict its category in B
- Cover the same set of papers but from a fresh angle

## Requirements
- Maintain 2-3 levels of hierarchy, targeting 5-15 leaf categories total
- Use snake_case for all category names
- Do NOT assign papers to categories
- Every leaf must have: name, chapter, description, phrases, hard_negative
- Chapter numbering: "1", "1.1", "1.1.1", "1.1(a)"

Single category schema example:
${TAXONOMY_SCHEMA_EXAMPLE}

Output a single JSON object:
{
  "perspective": "${bName}",
  "description": "1 sentence explaining this NEW organizing angle.",
  "categories": [ ... ]
}`;
}

/** Which boundary metrics failed for each taxonomy; M4 is global (_collect_per_taxonomy_failures). */
export function perTaxonomyFailures(verdicts: Record<string, Verdict>, allTaxonomies: string[]): Record<string, string[]> {
  const out = new Map<string, string[]>();
  for (const mid of ['m1', 'm2', 'm3', 'm6']) {
    const v = verdicts[mid];
    if (!v || v.passed) continue;
    for (const tax of v.failing_taxonomies) {
      if (!out.has(tax)) out.set(tax, []);
      out.get(tax)!.push(mid);
    }
  }
  const m4 = verdicts.m4;
  if (m4 && !m4.passed) {
    const targets = out.size ? [...out.keys()] : allTaxonomies;
    for (const tax of targets) {
      if (!out.has(tax)) out.set(tax, []);
      if (!out.get(tax)!.includes('m4')) out.get(tax)!.push('m4');
    }
  }
  return Object.fromEntries(out);
}

export interface RefineStep {
  taxonomy: string;
  phase: 'M7' | 'boundary' | 'M8';
  oldLeaves: number;
  newLeaves: number;
  added: string[];
  removed: string[];
  kept: number;
  error?: string;
}

type Ctx = Pick<CallOptions, 'key' | 'signal' | 'onUsage' | 'onRetry'>;

/**
 * Verdict-driven refinement (run_refinement): M7 rebalancing, then boundary clarification for
 * M1–M4/M6 failures, then a redesign of one taxonomy per redundant pair (M8). Each phase works on
 * the output of the previous one. Returns the refined taxonomies without touching the project.
 */
export async function refineTaxonomies(
  project: Project,
  metrics: Metrics,
  s: Settings,
  ctx: Ctx,
  onStep?: (step: RefineStep) => void,
): Promise<{ taxonomies: Taxonomy[]; steps: RefineStep[] }> {
  const working = new Map(project.taxonomies.map((t) => [t.name, { ...t, items: structuredClone(t.items) }]));
  const steps: RefineStep[] = [];
  const total = Object.keys(project.consensus).length;
  const verdicts = metrics.verdicts;

  async function refineOne(name: string, phase: RefineStep['phase'], system: string, user: string) {
    const tax = working.get(name)!;
    const oldLeaves = collectLeafChapters(tax.items);
    const oldNames = new Set(Object.values(collectAllChapterNames(tax.items)));
    try {
      const result = (await callJson({ ...ctx, model: s.refiner, system, user, temperature: s.refinerTemperature, maxTokens: s.generationMaxTokens })) as any;
      const categories: TaxNode[] = Array.isArray(result) ? result : (result?.categories ?? []);
      if (!categories.length) throw new Error('Refiner returned no categories');
      working.set(name, { ...tax, description: result?.description ?? tax.description, items: categories });
      const newNames = new Set(Object.values(collectAllChapterNames(categories)));
      const step: RefineStep = {
        taxonomy: name,
        phase,
        oldLeaves: oldLeaves.size,
        newLeaves: collectLeafChapters(categories).size,
        added: sortStr([...newNames].filter((n) => !oldNames.has(n))),
        removed: sortStr([...oldNames].filter((n) => !newNames.has(n))),
        kept: [...oldNames].filter((n) => newNames.has(n)).length,
      };
      steps.push(step);
      onStep?.(step);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      const step: RefineStep = { taxonomy: name, phase, oldLeaves: oldLeaves.size, newLeaves: oldLeaves.size, added: [], removed: [], kept: 0, error: (e as Error).message };
      steps.push(step);
      onStep?.(step);
    }
  }

  if (verdicts.m7 && !verdicts.m7.passed)
    for (const name of verdicts.m7.failing_taxonomies) {
      const tax = working.get(name);
      if (!tax) continue;
      const stats = refineStats(consensusCoverage(project.consensus, name), collectLeafChapters(tax.items), collectAllChapterNames(tax.items), total);
      await refineOne(name, 'M7', REFINE_SYSTEM_BALANCE, buildCoverageRefinePrompt(name, tax.items, stats));
    }

  const boundary = perTaxonomyFailures(verdicts, [...working.keys()]);
  for (const name of sortStr(Object.keys(boundary))) {
    const tax = working.get(name);
    if (!tax) continue;
    await refineOne(name, 'boundary', REFINE_SYSTEM_BOUNDARIES, buildBoundaryRefinePrompt(name, tax.items, boundary[name], metrics));
  }

  if (verdicts.m8 && !verdicts.m8.passed)
    for (const pair of verdicts.m8.redundant_pairs ?? []) {
      const [a, b] = pair.split(' vs ').map((x) => x.trim());
      const ta = working.get(a);
      const tb = working.get(b);
      if (!ta || !tb) continue;
      const v = (metrics.taxonomy_independence.pairs as any)[pair]?.cramers_v ?? 0;
      await refineOne(b, 'M8', REFINE_SYSTEM_REDUNDANCY, buildRedundancyRefinePrompt(a, ta.items, b, tb.items, v));
    }

  return { taxonomies: [...working.values()], steps };
}
