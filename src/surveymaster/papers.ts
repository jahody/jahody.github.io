// Stage 1, getting papers. 1_fetch.py uses Asta, which needs a key and can't be called from a
// browser, so the web app searches OpenAlex (no key, CORS enabled) or takes papers the user
// pastes or uploads. Each paper's `content` matches papers/{topic}/abstracts/*.md.

import type { Paper } from './types';

const ARXIV_RE = /arxiv[^0-9]*?(\d{4}\.\d{4,5})/i;
const ARXIV_ID = /^\d{4}\.\d{4,5}$/;

/** Rebuild an abstract from OpenAlex's inverted index ({word: [positions]}). */
export function invertedToText(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(' ');
}

/** The Markdown the Python pipeline stores per paper, so prompts read the same. */
export function paperMarkdown(p: { title: string; id?: string; arxiv?: string; date?: string; authors?: string; abstract: string }) {
  const lines = [`# ${p.title}`, ''];
  if (p.arxiv) lines.push(`**arXiv ID:** [${p.arxiv}](https://arxiv.org/abs/${p.arxiv})`);
  if (p.date) lines.push(`**Published:** ${p.date}`);
  if (p.authors) lines.push(`**Authors:** ${p.authors}`);
  lines.push('', '## Abstract', '', p.abstract.trim());
  return lines.join('\n');
}

function dateParts(date?: string): { year?: number; month?: number } {
  const m = date?.match(/^(\d{4})-(\d{2})/);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : {};
}

export interface SearchOptions {
  limit: number;
  fromYear?: number;
  signal?: AbortSignal;
}

/** Search OpenAlex for works with abstracts, most relevant first. */
export async function searchOpenAlex(query: string, { limit, fromYear, signal }: SearchOptions): Promise<Paper[]> {
  const filters = ['has_abstract:true'];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
  const params = new URLSearchParams({
    search: query,
    filter: filters.join(','),
    // Over-fetch: preprints and published versions are separate works and get merged below.
    'per-page': String(Math.min(Math.ceil(Math.max(limit, 1) * 1.5), 200)),
    select: 'id,doi,display_name,publication_date,authorships,abstract_inverted_index,locations',
  });
  const r = await fetch(`https://api.openalex.org/works?${params}`, { signal });
  if (!r.ok) throw new Error(`OpenAlex search failed (${r.status})`);
  const data = await r.json();

  // One entry per paper: the same title appears once per version (preprint, proceedings, journal).
  const byTitle = new Map<string, Paper>();
  for (const w of data.results ?? []) {
    const abstract = invertedToText(w.abstract_inverted_index);
    if (!abstract || !w.display_name) continue;
    const urls = [w.doi, ...(w.locations ?? []).map((l: any) => l.landing_page_url)].filter(Boolean).join(' ');
    const arxiv = urls.match(ARXIV_RE)?.[1];
    const id = arxiv ?? String(w.id).split('/').pop()!;
    const titleKey = String(w.display_name).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const previous = byTitle.get(titleKey);
    if (previous && (ARXIV_ID.test(previous.id) || !arxiv)) continue;
    const authorList = (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean);
    const authors = authorList.slice(0, 8).join(', ') + (authorList.length > 8 ? ', et al.' : '');
    byTitle.set(titleKey, {
      id,
      title: w.display_name,
      content: paperMarkdown({ title: w.display_name, arxiv, date: w.publication_date, authors, abstract }),
      authors,
      url: arxiv ? `https://arxiv.org/abs/${arxiv}` : (w.doi ?? w.id),
      ...dateParts(w.publication_date),
    });
  }
  return [...byTitle.values()].slice(0, limit);
}

const slugId = (s: string, i: number) =>
  s.match(/\d{4}\.\d{4,5}/)?.[0] ?? (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `paper-${i + 1}`);

/**
 * Papers from pasted or uploaded text. Accepts a JSON array of {title, abstract, id?, date?, authors?}
 * or Markdown where each paper starts with a "# Title" line (the abstracts/*.md format).
 */
export function parsePapers(text: string): Paper[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const rows = JSON.parse(trimmed) as any[];
    return rows
      .filter((r) => r && (r.title || r.abstract || r.content))
      .map((r, i) => {
        const title = String(r.title ?? `Paper ${i + 1}`);
        const date = r.date ?? r.publication_date ?? (r.year ? `${r.year}-01` : undefined);
        const arxiv = String(r.arxiv ?? r.id ?? '').match(/\d{4}\.\d{4,5}/)?.[0];
        const id = String(r.id ?? arxiv ?? slugId(title, i));
        return {
          id,
          title,
          content: r.content ?? paperMarkdown({ title, arxiv, date, authors: r.authors, abstract: String(r.abstract ?? '') }),
          authors: r.authors,
          url: r.url ?? (arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined),
          ...dateParts(date),
        };
      });
  }
  const blocks = trimmed.split(/^(?=# )/m).filter((b) => b.trim().startsWith('# '));
  return blocks.map((block, i) => {
    const title = block.split('\n', 1)[0].replace(/^#\s+/, '').trim();
    const arxiv = block.match(/arxiv[^0-9\n]*?(\d{4}\.\d{4,5})/i)?.[1];
    const date = block.match(/\*\*Published:\*\*\s*(\d{4}-\d{2}(?:-\d{2})?)/)?.[1];
    const authors = block.match(/\*\*Authors:\*\*\s*(.+)/)?.[1]?.trim();
    return {
      id: arxiv ?? slugId(title, i),
      title,
      content: block.trim(),
      authors,
      url: arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined,
      ...dateParts(date),
    };
  });
}
