import { useMemo, useState } from 'preact/hooks';
import { buildPrompt, chaptersOf, pendingJobs, runClassification, updateConsensus } from '../../surveymaster/classify';
import { collectAllChapterNames } from '../../surveymaster/evaluate';
import { paperFilename, type Project } from '../../surveymaster/types';
import { approxTokens, fmtInt, fmtTokens, fmtUsd, shortModel, type Api } from './shared';

const OUTPUT_TOKENS = 350;

export default function StepClassify({ api }: { api: Api }) {
  const p = api.project;
  const [taxName, setTaxName] = useState(p.taxonomies[0]?.name ?? '');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'title' | 'weak'>('title');
  const [openPaper, setOpenPaper] = useState<string | null>(null);

  const models = p.settings.models;
  const total = p.papers.length * p.taxonomies.length * models.length;
  const pending = pendingJobs(p);
  const failed = pending.filter((j) => p.results[j.model]?.[j.paper.id]?.[j.taxonomy.name]?.error).length;
  const done = total - pending.length;

  // Input tokens measured on the real prompts still to send; output assumed at about OUTPUT_TOKENS per call.
  const estimate = useMemo(() => {
    if (!p.papers.length || !p.taxonomies.length) return null;
    let inTokens = 0;
    const perModel = new Map<string, number>();
    for (const job of pending) {
      const t = approxTokens(buildPrompt(job.paper.content, job.taxonomy, paperFilename(job.paper), p.settings.topK, p.settings.includeHardNegative).length + 200);
      inTokens += t;
      perModel.set(job.model, (perModel.get(job.model) ?? 0) + t);
    }
    let cost = 0;
    let priced = true;
    for (const [m, t] of perModel) {
      const info = api.models.get(m);
      if (!info) priced = false;
      else cost += t * info.prompt + pending.filter((j) => j.model === m).length * OUTPUT_TOKENS * info.completion;
    }
    return { inTokens, outTokens: pending.length * OUTPUT_TOKENS, cost, priced };
  }, [p, pending.length, api.models]);

  function classify(reset = false) {
    if (reset && !confirm(`Discard all ${done} results and classify everything again?`)) return;
    if (reset) api.commit((proj) => ((proj.results = {}), (proj.consensus = {})));
    api.run('Classifying', async (ctx) => {
      try {
        await runClassification(p, ctx, (job, result) => {
          if (result.error) api.log(`${shortModel(job.model)} × ${job.paper.id} × ${job.taxonomy.name}: ${result.error}`);
          api.commit();
        });
      } finally {
        api.commit((proj) => updateConsensus(proj));
      }
    });
  }

  const freeModels = models.filter((m) => m.endsWith(':free'));

  return (
    <div class="stack">
      <div class="panel stack">
        <div class="spread">
          <div>
            <div class="mono">Classify</div>
            <p class="small muted" style={{ margin: '4px 0 0' }}>
              Every model picks the top {p.settings.topK} leaf categories for every paper in every taxonomy, with confidences summing to 100. Votes are then
              summed per category.
            </p>
          </div>
          <div class="row">
            {done > 0 && <button class="btn small ghost" disabled={!!api.busy} onClick={() => classify(true)}>Reclassify all</button>}
            <button class="btn primary" disabled={!!api.busy || !pending.length} onClick={() => classify()}>
              {pending.length ? `Run ${fmtInt(pending.length)} calls${failed ? ` (${failed} retries)` : ''}` : 'All classified'}
            </button>
          </div>
        </div>
        {!p.taxonomies.length && <div class="note">Build or import a taxonomy first (step 2).</div>}
        <div class="grid3">
          <Stat label="Calls" value={`${fmtInt(done)} / ${fmtInt(total)}`} sub={`${p.papers.length} papers × ${p.taxonomies.length} taxonom${p.taxonomies.length === 1 ? 'y' : 'ies'} × ${models.length} models`} />
          <Stat label="Still to run" value={fmtInt(pending.length)} sub={estimate ? `≈ ${fmtTokens(estimate.inTokens)} in, ${fmtTokens(estimate.outTokens)} out` : '—'} />
          <Stat label="Estimated cost" value={estimate ? (estimate.priced ? fmtUsd(estimate.cost) : 'unknown') : '—'} sub={freeModels.length === models.length ? 'free models' : 'from OpenRouter prices'} />
        </div>
        <div class="bar"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        {freeModels.length > 0 && (
          <div class="note">
            Free models are rate-limited by OpenRouter per minute and per day. The app waits and retries when it hits a limit; without purchased credits, a large
            run may not finish in one day. Results are kept, so you can continue later.
          </div>
        )}
        {!api.hasKey && pending.length > 0 && <div class="note">Needs an OpenRouter key. <button class="link" onClick={api.askKey}>Add one</button></div>}
        {total > 0 && <Cells project={p} />}
      </div>

      {Object.keys(p.consensus).length > 0 && (
        <ConsensusTable api={api} taxName={taxName} setTaxName={setTaxName} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} openPaper={openPaper} setOpenPaper={setOpenPaper} />
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div class="metric">
      <div class="mono">{label}</div>
      <div class="value">{value}</div>
      <div class="detail">{sub}</div>
    </div>
  );
}

/** One square per paper × taxonomy for each model: filled when done, hatched when failed. */
function Cells({ project: p }: { project: Project }) {
  return (
    <div class="stack" style={{ gap: '8px' }}>
      {p.settings.models.map((m) => (
        <div>
          <div class="mono" style={{ marginBottom: '4px' }}>{shortModel(m)}</div>
          <div class="cells" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(9px, 1fr))' }}>
            {p.papers.flatMap((paper) =>
              p.taxonomies.map((t) => {
                const r = p.results[m]?.[paper.id]?.[t.name];
                return <i class={r ? (r.error ? 'err' : 'ok') : ''} title={`${paper.title} · ${t.name}${r?.error ? ` · ${r.error}` : ''}`} />;
              }),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConsensusTable(props: {
  api: Api;
  taxName: string;
  setTaxName: (t: string) => void;
  filter: string;
  setFilter: (f: string) => void;
  sort: 'title' | 'weak';
  setSort: (s: 'title' | 'weak') => void;
  openPaper: string | null;
  setOpenPaper: (id: string | null) => void;
}) {
  const { api, filter, sort, openPaper } = props;
  const p = api.project;
  const tax = p.taxonomies.find((t) => t.name === props.taxName) ?? p.taxonomies[0];
  if (!tax) return null;
  const names = collectAllChapterNames(tax.items);
  const models = p.settings.models;
  const label = (ch: string) => (names[ch] ? `${ch} ${names[ch].replace(/_/g, ' ')}` : ch);

  const rows = p.papers
    .map((paper) => ({ paper, c: p.consensus[paper.id]?.[tax.name] }))
    .filter((r) => r.c && (!filter || r.paper.title.toLowerCase().includes(filter.toLowerCase()) || label(r.c.chapter).toLowerCase().includes(filter.toLowerCase())));
  const top1Share = (r: (typeof rows)[number]) => {
    const m = r.c!.reason.match(/(\d+)\/(\d+)/);
    return m ? Number(m[1]) / Math.max(1, Number(m[2])) : 0;
  };
  if (sort === 'weak') rows.sort((a, b) => top1Share(a) - top1Share(b) || a.paper.title.localeCompare(b.paper.title));
  else rows.sort((a, b) => a.paper.title.localeCompare(b.paper.title));

  return (
    <div class="panel stack">
      <div class="spread">
        <div class="mono">Consensus · {rows.length} papers</div>
        <div class="row">
          {p.taxonomies.length > 1 && (
            <select value={tax.name} onChange={(e) => props.setTaxName(e.currentTarget.value)} style={{ width: 'auto' }}>
              {p.taxonomies.map((t) => <option value={t.name}>{t.name}</option>)}
            </select>
          )}
          <select value={sort} onChange={(e) => props.setSort(e.currentTarget.value as 'title' | 'weak')} style={{ width: 'auto' }}>
            <option value="title">Sort by title</option>
            <option value="weak">Weakest agreement first</option>
          </select>
          <input type="search" placeholder="Filter" value={filter} onInput={(e) => props.setFilter(e.currentTarget.value)} style={{ width: '180px' }} />
        </div>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Paper</th>
              <th>Consensus category</th>
              <th style={{ width: '120px' }}>Votes</th>
              <th>Agree</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ paper, c }) => {
              const totalVotes = c!.votes.reduce((n, [, v]) => n + v, 0) || 1;
              return (
                <>
                  <tr class="clickable" onClick={() => props.setOpenPaper(openPaper === paper.id ? null : paper.id)}>
                    <td>{paper.title}</td>
                    <td>{label(c!.chapter)}</td>
                    <td>
                      <div class="votes" title={c!.votes.map(([ch, v]) => `${ch}: ${v}`).join(', ')}>
                        {c!.votes.map(([, v]) => <i style={{ width: `${(v / totalVotes) * 100}%` }} />)}
                      </div>
                    </td>
                    <td class="num">{c!.reason.match(/\d+\/\d+/)?.[0]}</td>
                  </tr>
                  {openPaper === paper.id && (
                    <tr>
                      <td colSpan={4}>
                        <div class="grid3">
                          {models.map((m) => (
                            <div class="drawer">
                              <div class="mono" style={{ marginBottom: '4px' }}>{shortModel(m)}</div>
                              {chaptersOf(p.results[m]?.[paper.id]?.[tax.name]).map((v) => (
                                <div class="small" style={{ marginBottom: '6px' }}>
                                  <strong style={{ fontWeight: 500 }}>{v.confidence}%</strong> {label(String(v.chapter))}
                                  {v.reason && <div class="muted">{v.reason}</div>}
                                </div>
                              ))}
                              {p.results[m]?.[paper.id]?.[tax.name]?.error && <div class="small" style={{ color: 'var(--bad)' }}>{p.results[m][paper.id][tax.name].error}</div>}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <button class="btn small primary" onClick={() => api.goto(3)}>Next: evaluate →</button>
      </div>
    </div>
  );
}
