import { useState } from 'preact/hooks';
import { updateConsensus } from '../../surveymaster/classify';
import { parsePapers, searchOpenAlex } from '../../surveymaster/papers';
import type { Paper } from '../../surveymaster/types';
import type { Api } from './shared';

export default function StepPapers({ api }: { api: Api }) {
  const p = api.project;
  const [query, setQuery] = useState(p.topic);
  const [limit, setLimit] = useState(30);
  const [fromYear, setFromYear] = useState('');
  const [searching, setSearching] = useState(false);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  function add(papers: Paper[], from: string) {
    const key = (x: Paper) => x.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const have = new Set(p.papers.flatMap((x) => [x.id, key(x)]));
    const fresh = papers.filter((x) => !have.has(x.id) && !have.has(key(x)) && (have.add(x.id), have.add(key(x)), true));
    api.commit((proj) => proj.papers.push(...fresh));
    setMsg(`${from}: added ${fresh.length} paper${fresh.length === 1 ? '' : 's'}${papers.length > fresh.length ? ` (${papers.length - fresh.length} already in the list)` : ''}.`);
  }

  async function search(e: Event) {
    e.preventDefault();
    setSearching(true);
    setMsg(null);
    try {
      add(await searchOpenAlex(query, { limit, fromYear: Number(fromYear) || undefined }), 'OpenAlex');
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function addPasted(text: string, from: string) {
    try {
      const papers = parsePapers(text);
      if (!papers.length) throw new Error('No papers found. Use a JSON array or Markdown with a "# Title" line per paper.');
      add(papers, from);
      setPaste('');
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  function remove(ids: string[]) {
    const drop = new Set(ids);
    api.commit((proj) => {
      proj.papers = proj.papers.filter((x) => !drop.has(x.id));
      for (const results of Object.values(proj.results)) for (const id of drop) delete results[id];
      updateConsensus(proj);
    });
  }

  const hasResults = Object.keys(p.consensus).length > 0;

  return (
    <div class="stack">
      <div class="grid2">
        <form class="panel stack" onSubmit={search}>
          <div class="mono">Search OpenAlex</div>
          <label class="field">
            <span class="mono">Topic</span>
            <input type="text" value={p.topic} onChange={(e) => api.commit((proj) => (proj.topic = e.currentTarget.value.trim() || proj.topic))} />
          </label>
          <label class="field">
            <span class="mono">Search query</span>
            <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
          <div class="grid2">
            <label class="field">
              <span class="mono">Papers (max 100)</span>
              <input type="number" min={1} max={100} value={limit} onInput={(e) => setLimit(Math.min(100, Math.max(1, Number(e.currentTarget.value) || 30)))} />
            </label>
            <label class="field">
              <span class="mono">Published from (year)</span>
              <input type="number" min={1950} max={2100} placeholder="any" value={fromYear} onInput={(e) => setFromYear(e.currentTarget.value)} />
            </label>
          </div>
          <div class="row">
            <button class="btn primary" type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search and add'}</button>
            <span class="small muted">Free, no key. Titles and abstracts from openalex.org.</span>
          </div>
        </form>
        <div class="panel stack">
          <div class="mono">Paste or upload</div>
          <textarea
            rows={7}
            placeholder={'# Paper title\n\n**arXiv ID:** 2302.07863\n**Published:** 2023-02-15\n\n## Abstract\n\n…\n\n(or a JSON array of {title, abstract, id, date})'}
            value={paste}
            onInput={(e) => setPaste(e.currentTarget.value)}
          />
          <div class="row">
            <button class="btn" onClick={() => addPasted(paste, 'Pasted text')} disabled={!paste.trim()}>Add</button>
            <input type="file" accept=".md,.txt,.json" onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (f) addPasted(await f.text(), f.name);
              e.currentTarget.value = '';
            }} />
          </div>
        </div>
      </div>

      {msg && <div class="note">{msg}</div>}
      {hasResults && <div class="note warn">Removing a paper also removes its classifications. Added papers get classified in step 3.</div>}

      <div class="panel stack">
        <div class="spread">
          <div class="mono">{p.papers.length} papers</div>
          <div class="row">
            {p.papers.length > 0 && (
              <button class="btn small ghost" onClick={() => confirm('Remove all papers and their results?') && remove(p.papers.map((x) => x.id))}>Remove all</button>
            )}
            <button class="btn small primary" disabled={!p.papers.length} onClick={() => api.goto(1)}>Next: taxonomies →</button>
          </div>
        </div>
        {p.papers.length === 0 ? (
          <p class="small muted">No papers yet. Search above, or paste a list.</p>
        ) : (
          <ul class="list scroll">
            {p.papers.map((x) => (
              <li>
                <span class="grow">
                  <button class="link" style={{ textDecoration: 'none', textAlign: 'left' }} onClick={() => setOpen(open === x.id ? null : x.id)}>
                    {x.title}
                  </button>
                  <div class="small muted">
                    {[x.year, x.id, x.authors && (x.authors.length > 80 ? x.authors.slice(0, 80) + '…' : x.authors)].filter(Boolean).join(' · ')}
                    {x.url && (
                      <>
                        {' · '}
                        <a href={x.url} target="_blank" rel="noopener">source</a>
                      </>
                    )}
                  </div>
                  {open === x.id && <div class="drawer small" style={{ whiteSpace: 'pre-wrap' }}>{x.content}</div>}
                </span>
                <button class="x" aria-label={`Remove ${x.title}`} onClick={() => remove([x.id])}>×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
