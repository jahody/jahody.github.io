// Stage 3, the port of 3_classify.py: every paper × taxonomy × model gets one call returning the
// top-k leaf chapters with confidences summing to 100; results are then merged by
// confidence-weighted voting. Prompt text follows prompts/3_prompt.md.

import { callJson, Limiter, type CallOptions } from './llm';
import type { ChapterVote, Consensus, ConsensusEntry, ModelResults, Paper, Project, TaxNode, TaxResult, Taxonomy } from './types';
import { paperFilename } from './types';
import { sortStr } from './util';

export const SYSTEM_MESSAGE =
  'You are a research paper classification expert. Classify the given paper according to the provided taxonomy. Respond with valid JSON only.';

/** Leaf items only (collect_leaf_items). */
export function collectLeafItems(items: TaxNode[]): TaxNode[] {
  const leaves: TaxNode[] = [];
  for (const item of items) {
    if (item.items?.length) leaves.push(...collectLeafItems(item.items));
    else leaves.push(item);
  }
  return leaves;
}

export function buildPrompt(paperContent: string, taxonomy: Taxonomy, filename: string, topK = 3, includeHardNegative = true): string {
  let itemsText = '';
  for (const item of collectLeafItems(taxonomy.items)) {
    itemsText += `\n### ${item.name ?? 'Unknown'} (chapter ${item.chapter ?? 'unknown'})\n`;
    itemsText += `**Description:** ${item.description ?? ''}\n`;
    itemsText += `**Key phrases:** ${(item.phrases ?? []).join(', ')}\n`;
    if (includeHardNegative)
      itemsText += `**Hard negative (DO NOT assign if this describes the paper's approach):** ${item.hard_negative ?? ''}\n`;
  }

  return `## Paper Content

${paperContent}

---

## Taxonomy

Your task is to classify the paper according to a taxonomy mentioned at the end.
Select the top ${topK} most relevant leaf categories (those with no subcategories), ranked by relevance.
Assign a confidence percentage (integer, 0-100) to each. Confidences must sum to 100.

**Taxonomy: ${taxonomy.name}**
**Description:** ${taxonomy.description}

**Items:**
${itemsText}
---

Respond with a JSON object containing:
- "filename": the paper's filename (use "${filename}")
- "chapters": an array of exactly ${topK} objects, ranked from most to least relevant, each with:
  - "chapter": the chapter number
  - "confidence": integer percentage (0-100)
  - "reason": a short reason for this classification

Example:
{
    "filename": "${filename}",
    "chapters": [
        {"chapter": "3.1.2(a)", "confidence": 75, "reason": "primary reason"},
        {"chapter": "3.2.1", "confidence": 15, "reason": "secondary reason"},
        {"chapter": "3.1.3", "confidence": 10, "reason": "tertiary reason"}
    ]
}`;
}

/** item name → chapter, for every node (_build_name_to_chapter). */
export function nameToChapter(items: TaxNode[], mapping: Map<string, string> = new Map()): Map<string, string> {
  for (const item of items) {
    if (item.name !== undefined && item.chapter !== undefined) mapping.set(item.name, String(item.chapter));
    if (item.items) nameToChapter(item.items, mapping);
  }
  return mapping;
}

export type TaxonomyLookup = Map<string, Map<string, string>>;

export const taxonomyLookup = (taxonomies: Taxonomy[]): TaxonomyLookup =>
  new Map(taxonomies.map((t) => [t.name, nameToChapter(t.items)]));

/** If a model answered with a category name, map it back to its chapter number (_normalize_chapter). */
export function normalizeChapter(chapter: string, taxName: string, lookup: TaxonomyLookup): string {
  const nameMap = lookup.get(taxName);
  const direct = nameMap?.get(chapter);
  if (direct !== undefined) return direct;
  const m = chapter.match(/\(chapter\s+([\d.]+(?:\([a-z]\))?)\)/);
  return m ? m[1] : chapter;
}

function normalizeResult(result: TaxResult, taxName: string, lookup: TaxonomyLookup) {
  for (const entry of result.chapters ?? [])
    if (entry && typeof entry === 'object' && 'chapter' in entry) entry.chapter = normalizeChapter(String(entry.chapter), taxName, lookup);
}

type Ctx = Pick<CallOptions, 'key' | 'signal' | 'onUsage' | 'onRetry'>;

/** One call for one paper × taxonomy × model. Never throws: failures come back as {error}. */
export async function classifyOne(paper: Paper, taxonomy: Taxonomy, model: string, project: Project, ctx: Ctx): Promise<TaxResult> {
  const s = project.settings;
  try {
    const out = (await callJson({
      ...ctx,
      model,
      system: SYSTEM_MESSAGE,
      user: buildPrompt(paper.content, taxonomy, paperFilename(paper), s.topK, s.includeHardNegative),
      temperature: s.classifyTemperature,
      maxTokens: s.classifyMaxTokens,
      seed: s.seed,
    })) as any;
    const result: TaxResult = { chapters: Array.isArray(out?.chapters) ? out.chapters : [] };
    if (!result.chapters!.length && out?.chapter !== undefined) {
      result.chapter = out.chapter;
      result.confidence = out.confidence;
    }
    if (!result.chapters!.length && result.chapter === undefined) return { error: 'No chapters in response' };
    normalizeResult(result, taxonomy.name, taxonomyLookup([taxonomy]));
    return result;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { error: (e as Error).message };
  }
}

export interface ClassifyJob {
  paper: Paper;
  taxonomy: Taxonomy;
  model: string;
}

/** Jobs still to run: missing or failed results only (skip_existing: true). */
export function pendingJobs(project: Project): ClassifyJob[] {
  const jobs: ClassifyJob[] = [];
  for (const model of project.settings.models)
    for (const paper of project.papers)
      for (const taxonomy of project.taxonomies) {
        const r = project.results[model]?.[paper.id]?.[taxonomy.name];
        if (!r || r.error) jobs.push({ paper, taxonomy, model });
      }
  return jobs;
}

/** Run every pending job through the limiter, writing results into the project as they arrive. */
export async function runClassification(
  project: Project,
  ctx: Ctx,
  onResult: (job: ClassifyJob, result: TaxResult) => void,
): Promise<void> {
  const limiter = new Limiter(project.settings.concurrency);
  await Promise.all(
    pendingJobs(project).map((job) =>
      limiter.run(async () => {
        ctx.signal?.throwIfAborted();
        const result = await classifyOne(job.paper, job.taxonomy, job.model, project, ctx);
        ((project.results[job.model] ??= {})[job.paper.id] ??= {})[job.taxonomy.name] = result;
        onResult(job, result);
      }),
    ),
  );
}

/** The ranked chapters of one result, filling in older single-chapter formats. */
export function chaptersOf(r: TaxResult | undefined): ChapterVote[] {
  if (!r || r.error) return [];
  let chapters: any[] = r.chapters ?? [];
  if (!chapters.length && r.chapter !== undefined) {
    const ch = r.chapter;
    chapters = Array.isArray(ch)
      ? ch.map((c) => ({ chapter: c, confidence: Math.floor(100 / Math.max(ch.length, 1)) }))
      : [{ chapter: ch, confidence: 100 }];
  }
  return chapters;
}

/** Confidence-weighted voting across models (aggregate_votes). */
export function aggregateVotes(allModelResults: Record<string, ModelResults>, lookup?: TaxonomyLookup): Consensus {
  const allPapers = new Set<string>();
  for (const results of Object.values(allModelResults)) for (const p of Object.keys(results)) allPapers.add(p);

  const consensus: Consensus = {};
  for (const paper of sortStr(allPapers)) {
    const paperTaxonomies = new Map<string, Map<string, number>>();
    let modelCount = 0;

    for (const results of Object.values(allModelResults)) {
      const paperData = results[paper];
      if (!paperData) continue;
      modelCount++;
      for (const [taxName, taxResult] of Object.entries(paperData)) {
        if (taxResult.error) continue;
        const chapters = chaptersOf(taxResult);
        for (const entry of chapters) {
          let chapter: string;
          let confidence: number;
          if (entry && typeof entry === 'object') {
            chapter = String(entry.chapter ?? 'unknown');
            const c = Number(entry.confidence ?? 100);
            confidence = Number.isFinite(c) ? c : 100 / Math.max(chapters.length, 1);
          } else {
            chapter = String(entry);
            confidence = 100 / Math.max(chapters.length, 1);
          }
          if (lookup) chapter = normalizeChapter(chapter, taxName, lookup);
          if (!paperTaxonomies.has(taxName)) paperTaxonomies.set(taxName, new Map());
          const scores = paperTaxonomies.get(taxName)!;
          scores.set(chapter, (scores.get(chapter) ?? 0) + confidence);
        }
      }
    }

    const classifications: Record<string, ConsensusEntry> = {};
    for (const [taxName, scores] of paperTaxonomies) {
      const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      const [winner, winnerScore] = sorted[0];
      let top1 = 0;
      for (const results of Object.values(allModelResults)) {
        const paperData = results[paper];
        if (!paperData) continue;
        const first = chaptersOf(paperData[taxName])[0];
        let firstCh = first ? String(typeof first === 'object' ? first.chapter : first) : null;
        if (firstCh && lookup) firstCh = normalizeChapter(firstCh, taxName, lookup);
        if (firstCh === winner) top1++;
      }
      classifications[taxName] = {
        chapter: winner,
        score: winnerScore,
        votes: sorted.map(([ch, sc]) => [ch, Math.trunc(sc)]),
        reason: `Consensus: ${top1}/${modelCount} models ranked this #1`,
      };
    }
    consensus[paper] = classifications;
  }
  return consensus;
}

/** Results of the models currently in the vote, in settings order (models removed in settings drop out). */
export function activeResults(project: Project): Record<string, ModelResults> {
  return Object.fromEntries(project.settings.models.filter((m) => project.results[m]).map((m) => [m, project.results[m]]));
}

/** Recompute the project's consensus from its current results. */
export function updateConsensus(project: Project) {
  project.consensus = aggregateVotes(activeResults(project), taxonomyLookup(project.taxonomies));
}
