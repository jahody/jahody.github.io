// Stage 5, the port of 5_evolve.py: each model proposes "builds on" edges between papers (in
// overlapping chronological chunks for large sets), the refiner merges the proposals, and the
// result is validated and laid out by time period. Prompt text is copied verbatim.
// One extension: papers without an arXiv ID take their date from the publication date.

import { callJson, type CallOptions } from './llm';
import type { Consensus, EvolutionEdge, EvolutionTree, Paper, Settings, TaxNode, Taxonomy } from './types';
import { dumps, slugifyModel } from './util';

export const SYSTEM_MESSAGE =
  'You are an expert research historian specializing in tracking the evolution ' +
  'of ideas in academic research. Given a collection of papers with their content ' +
  'and taxonomy classification, identify how papers build upon, extend, or are ' +
  'influenced by earlier work. Respond with valid JSON only.';

export const REFINE_SYSTEM =
  'You are an expert research historian. Given multiple evolution tree proposals ' +
  'from different models, merge them into a single coherent evolution tree. ' +
  'Resolve conflicts, remove duplicate or weak relationships, and ensure the ' +
  'final tree accurately represents the research lineage. Respond with valid JSON only.';

/** (year, month) from an arXiv ID prefix, e.g. "2501.12948" → [2025, 1] (parse_arxiv_date). */
export function parseArxivDate(id: string): [number, number] | null {
  const m = id.match(/^(\d{2})(\d{2})\.\d+/);
  if (!m) return null;
  const yy = Number(m[1]);
  return [yy < 90 ? 2000 + yy : 1900 + yy, Number(m[2])];
}

export const paperDate = (p: Paper): [number, number] | null => parseArxivDate(p.id) ?? (p.year ? [p.year, p.month ?? 1] : null);

const cmpDate = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];

export function assignTimePeriod(year: number, month: number): string {
  if (year <= 2022) return `Y${year}`;
  if (year === 2023) return 'Y2023';
  if (year === 2024) return `Y2024_H${month <= 6 ? '1' : '2'}`;
  return `Y${year}_Q${Math.floor((month - 1) / 3) + 1}`;
}

/** paper id → its consensus categories with full paths (load_taxonomy_lookups + build_category_map). */
export function buildCategoryMap(taxonomies: Taxonomy[], consensus: Consensus) {
  const lookups = new Map<string, Map<string, { name: string; full_path: string }>>();
  for (const t of taxonomies) {
    const lookup = new Map<string, { name: string; full_path: string }>();
    const walk = (items: TaxNode[], path: string[]) => {
      for (const item of items) {
        const current = [...path, item.name];
        if (item.chapter !== undefined) lookup.set(String(item.chapter), { name: item.name, full_path: current.join(' / ') });
        if (item.items) walk(item.items, current);
      }
    };
    walk(t.items, []);
    lookups.set(t.name, lookup);
  }
  const map: Record<string, { taxonomy: string; chapter: string; name: string; full_path: string }[]> = {};
  for (const [paper, taxes] of Object.entries(consensus))
    for (const [tax, r] of Object.entries(taxes)) {
      const info = r.chapter ? lookups.get(tax)?.get(r.chapter) : undefined;
      if (info) (map[paper] ??= []).push({ taxonomy: tax, chapter: r.chapter, ...info });
    }
  return map;
}

const sortChronologically = (papers: Paper[]) =>
  papers
    .map((p) => ({ d: paperDate(p) ?? ([9999, 99] as [number, number]), p }))
    .sort((a, b) => cmpDate(a.d, b.d));

export function createChronologicalChunks(papers: Paper[], chunkSize: number, overlap: number): Paper[][] {
  const sorted = sortChronologically(papers).map((x) => x.p);
  if (sorted.length <= chunkSize) return [sorted];
  const chunks: Paper[][] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let start = 0; start < sorted.length; start += step) {
    const chunk = sorted.slice(start, start + chunkSize);
    if (chunk.length) chunks.push(chunk);
    if (start + chunkSize >= sorted.length) break;
  }
  return chunks;
}

export function buildEvolutionPrompt(
  papers: Paper[],
  categoryMap: ReturnType<typeof buildCategoryMap>,
  queryName: string,
  contentChars = 1200,
  chunk?: { index: number; total: number },
): string {
  let papersText = '';
  for (const { d, p } of sortChronologically(papers)) {
    const cats = categoryMap[p.id] ?? [];
    const catLabel = cats.length ? ` [${cats.map((c) => `${c.taxonomy}: ${c.chapter} ${c.name}`).join('; ')}]` : '';
    const dateLabel = d[0] < 9999 ? `${d[0]}-${String(d[1]).padStart(2, '0')}` : 'unknown';
    const content = p.content.length > contentChars ? p.content.slice(0, contentChars) + '...' : p.content;
    papersText += `\n### ${p.title} (arxiv: ${p.id}, ${dateLabel})${catLabel}\n${content}\n---\n`;
  }
  const chunkContext = chunk ? `\nNote: This is chunk ${chunk.index + 1} of ${chunk.total}. Focus on relationships within this group of papers.\n` : '';

  return `Here are ${papers.length} papers on "${queryName}", listed chronologically:

${papersText}
${chunkContext}
Your task: Construct an evolution tree showing how these research ideas build on each other over time. Be thorough — find as many meaningful relationships as possible.

For each relationship, provide:
- source: arxiv ID of the earlier paper
- target: arxiv ID of the later paper that builds upon it
- type: one of the four types below
- label: short phrase (2-5 words) describing the specific connection

Edge types:
- "direct_extension" — Paper B explicitly extends, improves, or reimplements Paper A's method/architecture. Look for: same model name with improvements, v2/v3 versions, papers that modify a specific algorithm from Paper A.
- "conceptual_influence" — Paper B adapts or is clearly inspired by a key idea from Paper A, even if the implementation differs. This is the most common type — use it generously for any clear intellectual lineage.
- "shared_benchmark" — Both papers evaluate on the same specific benchmark (e.g., MMLU, GSM8K, HumanEval, MATH, MT-Bench). Include this even alongside other edge types.
- "challenges" — Paper B explicitly argues against, refutes, or demonstrates fundamental limitations of Paper A's approach.

Guidelines:
- IMPORTANT: Every paper should appear in at least one edge (as source or target). If a paper seems isolated, look harder for conceptual connections to the most related paper.
- When in doubt about whether a relationship exists, include it as "conceptual_influence" — it is better to include a plausible relationship than to miss a real one.
- A paper can have multiple predecessors and successors — aim for 1-3 incoming edges per paper.
- Papers from the same time period working on similar sub-problems likely share influences from the same earlier work.
- Edges must flow from earlier to later papers (check the arxiv ID dates: YYMM format).
- Use "direct_extension" for clear technical building blocks (not just topical similarity).

Output JSON:
{
  "edges": [
    {
      "source": "2201.11903",
      "target": "2501.12948",
      "type": "direct_extension",
      "label": "pure RL reasoning"
    }
  ]
}`;
}

export function buildRefinePrompt(proposals: { model: string; edges: EvolutionEdge[] }[], papers: Paper[], queryName: string, chunkMode = false): string {
  let proposalsText = '';
  proposals.forEach((entry, i) => {
    proposalsText += `\n## Proposal ${i + 1} from ${slugifyModel(entry.model)} (${entry.edges.length} edges)\n`;
    proposalsText += `\`\`\`json\n${dumps(entry.edges)}\n\`\`\`\n---\n`;
  });
  let paperList = '';
  for (const p of papers) {
    const d = paperDate(p);
    paperList += `- ${p.title} (arxiv: ${p.id}, ${d ? `${d[0]}-${String(d[1]).padStart(2, '0')}` : 'unknown'})\n`;
  }
  const chunkNote = chunkMode
    ? '\nNote: Proposals were generated from overlapping paper chunks, so many edges ' +
      'appear in only one proposal. This is expected — do NOT remove edges just because ' +
      'they come from a single source.\n'
    : '';

  return `Here are ${proposals.length} evolution tree proposals for ${papers.length} papers on "${queryName}":

${proposalsText}

Papers:
${paperList}
${chunkNote}
Merge these proposals into ONE coherent, DENSE evolution tree.

Target density: approximately ${papers.length} edges for ${papers.length} papers (roughly 1-2 edges per paper). The goal is a well-connected tree where most papers participate.

Edge types: "direct_extension", "conceptual_influence", "shared_benchmark", "challenges"

Rules:
1. **Consensus**: edges proposed by multiple models are high-confidence — always keep them
2. **Conflicts**: if models disagree on type/label for the same source->target, pick the most accurate
3. **Single-source edges**: keep them unless they are clearly wrong (nonsensical relationship or wrong chronological direction). Do NOT bulk-remove edges just because only one source proposed them.
4. **Deduplicate**: if multiple edges exist between the same two papers, keep only the strongest/most specific
5. **Chronology**: edges must flow from earlier to later papers (check arxiv ID dates: YYMM prefix)
6. **Coverage check**: after merging, verify that every paper appears in at least one edge. For any isolated paper, add a "conceptual_influence" edge connecting it to the most topically related paper.

Output the final merged tree:
{
  "edges": [
    {
      "source": "arxiv_id",
      "target": "arxiv_id",
      "type": "direct_extension",
      "label": "short phrase"
    }
  ]
}`;
}

const edgesOf = (result: unknown): EvolutionEdge[] =>
  result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as any).edges) ? (result as any).edges : [];

/** Drop edges to unknown papers, backwards in time, or duplicated (validate_and_patch_edges). */
export function validateEdges(edges: EvolutionEdge[], papers: Paper[]) {
  const valid = new Set(papers.map((p) => p.id));
  const dates = new Map(papers.map((p) => [p.id, paperDate(p)]));
  const seen = new Set<string>();
  const cleaned: EvolutionEdge[] = [];
  const removed = { unknown: 0, chrono: 0, duplicate: 0 };
  for (const e of edges) {
    const src = String(e.source);
    const tgt = String(e.target);
    if (!valid.has(src) || !valid.has(tgt)) {
      removed.unknown++;
      continue;
    }
    const ds = dates.get(src);
    const dt = dates.get(tgt);
    if (ds && dt && cmpDate(ds, dt) > 0) {
      removed.chrono++;
      continue;
    }
    const key = `${src}\u0000${tgt}`;
    if (seen.has(key)) {
      removed.duplicate++;
      continue;
    }
    seen.add(key);
    cleaned.push({ ...e, source: src, target: tgt });
  }
  const covered = new Set(cleaned.flatMap((e) => [e.source, e.target]));
  return { edges: cleaned, removed, isolated: [...valid].filter((id) => !covered.has(id)) };
}

export function buildFinalOutput(edges: EvolutionEdge[], papers: Paper[], queryName: string): EvolutionTree {
  const nodes = papers
    .map((p) => {
      const d = paperDate(p);
      return { arxiv: p.id, name: p.title, time_period: d ? assignTimePeriod(d[0], d[1]) : 'Unknown', year: d?.[0] ?? null, month: d?.[1] ?? null };
    })
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || (a.month ?? 99) - (b.month ?? 99));
  const seen = new Set<string>();
  const timePeriods: { id: string; label: string }[] = [];
  for (const n of nodes)
    if (n.time_period !== 'Unknown' && !seen.has(n.time_period)) {
      seen.add(n.time_period);
      timePeriods.push({ id: n.time_period, label: n.time_period.replace(/_/g, ' ').replace(/^Y+/, '') });
    }
  return {
    metadata: { query: queryName, generated_at: new Date().toISOString(), total_papers: nodes.length, total_edges: edges.length },
    nodes,
    edges,
    time_periods: timePeriods,
  };
}

type Ctx = Pick<CallOptions, 'key' | 'signal' | 'onUsage' | 'onRetry'>;

/** Full stage: proposals from every model (chunked when large), then the refiner merges them. */
export async function runEvolution(
  papers: Paper[],
  taxonomies: Taxonomy[],
  consensus: Consensus,
  queryName: string,
  s: Settings,
  ctx: Ctx,
  onProgress?: (message: string) => void,
): Promise<{ tree: EvolutionTree; removed: { unknown: number; chrono: number; duplicate: number }; isolated: string[] }> {
  const categoryMap = buildCategoryMap(taxonomies, consensus);
  const chunks = s.chunkSize > 0 && papers.length > s.chunkSize ? createChronologicalChunks(papers, s.chunkSize, s.chunkOverlap) : null;
  const call = (model: string, user: string, system = SYSTEM_MESSAGE) =>
    callJson({ ...ctx, model, system, user, temperature: s.evolutionTemperature, maxTokens: s.evolutionMaxTokens });

  const proposals = (
    await Promise.all(
      s.models.map(async (model) => {
        try {
          let edges: EvolutionEdge[] = [];
          if (chunks && chunks.length > 1) {
            const all: EvolutionEdge[] = [];
            for (let i = 0; i < chunks.length; i++) {
              onProgress?.(`${slugifyModel(model)}: chunk ${i + 1}/${chunks.length}`);
              all.push(...edgesOf(await call(model, buildEvolutionPrompt(chunks[i], categoryMap, queryName, s.contentChars, { index: i, total: chunks.length }))));
            }
            const seen = new Set<string>();
            edges = all.filter((e) => {
              const k = `${e.source}\u0000${e.target}`;
              return seen.has(k) ? false : (seen.add(k), true);
            });
          } else {
            onProgress?.(`${slugifyModel(model)}: proposing relationships`);
            edges = edgesOf(await call(model, buildEvolutionPrompt(papers, categoryMap, queryName, s.contentChars)));
          }
          onProgress?.(`${slugifyModel(model)}: ${edges.length} edges`);
          return { model, edges };
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          onProgress?.(`${slugifyModel(model)} failed: ${(e as Error).message}`);
          return null;
        }
      }),
    )
  ).filter((p): p is { model: string; edges: EvolutionEdge[] } => p !== null);

  if (!proposals.length) throw new Error('No model produced an evolution proposal');
  let merged: EvolutionEdge[];
  if (proposals.length < 2) {
    merged = proposals[0].edges;
  } else {
    onProgress?.(`${slugifyModel(s.refiner)}: merging ${proposals.length} proposals`);
    merged = edgesOf(await call(s.refiner, buildRefinePrompt(proposals, papers, queryName, chunks !== null), REFINE_SYSTEM));
  }
  const { edges, removed, isolated } = validateEdges(merged, papers);
  return { tree: buildFinalOutput(edges, papers, queryName), removed, isolated };
}
