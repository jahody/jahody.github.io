import { useState } from 'preact/hooks';
import { collectLeafItems, updateConsensus } from '../../surveymaster/classify';
import { axesFromProposals, proposeTaxonomies, refineTaxonomies } from '../../surveymaster/taxonomize';
import type { Project, TaxNode, Taxonomy } from '../../surveymaster/types';
import { approxTokens, fmtTokens, shortModel, type Api } from './shared';

const hasResults = (p: Project) => Object.values(p.results).some((r) => Object.keys(r).length);

function clearResults(p: Project) {
  p.results = {};
  p.consensus = {};
  p.evolution = undefined;
}

export default function StepTaxonomies({ api }: { api: Api }) {
  const p = api.project;
  const [view, setView] = useState<string | null>(null);
  const promptTokens = approxTokens(p.papers.reduce((n, x) => n + x.content.length + x.title.length + 30, 0) + 2500);
  const selected = p.axes.filter((a) => a.selected);

  function propose() {
    api.run('Proposing taxonomies', async (ctx) => {
      const proposals = await proposeTaxonomies(p.papers, p.topic, p.settings, ctx, (model, err) =>
        api.log(err ? `${shortModel(model)} failed: ${err}` : `${shortModel(model)} proposed its taxonomies`),
      );
      if (!proposals.length) throw new Error('No model returned a usable taxonomy');
      api.commit((proj) => {
        proj.proposals = proposals;
        proj.axes = axesFromProposals(proposals);
      });
    });
  }

  function build() {
    if (p.taxonomies.length && hasResults(p) && !confirm('Replace the current taxonomies? Classification results for them will be cleared.')) return;
    api.run('Building final taxonomies', async (ctx) => {
      const taxonomies = await refineTaxonomies(p.proposals, p.axes, p.topic, p.settings, ctx);
      if (!taxonomies.length) throw new Error('The refiner returned no taxonomies');
      api.commit((proj) => {
        proj.taxonomies = taxonomies;
        clearResults(proj);
      });
    });
  }

  return (
    <div class="stack">
      <div class="panel stack">
        <div class="spread">
          <div>
            <div class="mono">1 · Propose</div>
            <p class="small muted" style={{ margin: '4px 0 0' }}>
              Each of the {p.settings.models.length} models reads all {p.papers.length} papers (about {fmtTokens(promptTokens)} tokens each) and proposes taxonomies
              built along different organizing principles.
            </p>
          </div>
          <button class={`btn ${p.proposals.length ? '' : 'primary'}`} disabled={!!api.busy || !p.papers.length} onClick={propose}>
            {p.proposals.length ? 'Propose again' : `Propose with ${p.settings.models.length} models`}
          </button>
        </div>
        {!api.hasKey && <div class="note">Needs an OpenRouter key. <button class="link" onClick={api.askKey}>Add one</button></div>}
      </div>

      {p.axes.length > 0 && (
        <div class="panel stack">
          <div class="spread">
            <div>
              <div class="mono">2 · Choose axes</div>
              <p class="small muted" style={{ margin: '4px 0 0' }}>
                Tick the perspectives to keep and add constraints. The refiner ({shortModel(p.settings.refiner)}) merges every proposal that shares a perspective.
              </p>
            </div>
            <button class="btn primary" disabled={!!api.busy || !selected.length} onClick={build}>
              Build {selected.length} taxonom{selected.length === 1 ? 'y' : 'ies'}
            </button>
          </div>
          <ul class="list">
            {p.axes.map((a) => (
              <li style={{ flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
                <div class="spread">
                  <label class="check">
                    <input type="checkbox" checked={a.selected} onChange={(e) => api.commit(() => (a.selected = e.currentTarget.checked))} />
                    <strong style={{ fontWeight: 500 }}>{a.perspective}</strong>
                    <span class="small muted">{a.proposals} proposal{a.proposals === 1 ? '' : 's'}</span>
                  </label>
                  <button class="btn small ghost" onClick={() => setView(view === a.perspective ? null : a.perspective)}>
                    {view === a.perspective ? 'Hide' : 'View'}
                  </button>
                </div>
                {a.description && <div class="small muted">{a.description}</div>}
                {a.selected && (
                  <input type="text" placeholder="Optional comment for the refiner, e.g. separate training-time and inference-time methods" value={a.comment} onChange={(e) => api.commit(() => (a.comment = e.currentTarget.value))} />
                )}
                {view === a.perspective &&
                  p.proposals
                    .filter((x) => x.perspective === a.perspective)
                    .map((x) => (
                      <div class="frame">
                        <div class="mono" style={{ marginBottom: '8px' }}>{shortModel(x.model)}</div>
                        <Tree items={x.categories} />
                      </div>
                    ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="panel stack">
        <div class="spread">
          <div>
            <div class="mono">3 · Review and edit</div>
            <p class="small muted" style={{ margin: '4px 0 0' }}>
              {p.taxonomies.length
                ? 'Edit names, descriptions, key phrases and hard negatives. Wording changes are safe; renamed or removed categories need reclassifying.'
                : 'Final taxonomies appear here. You can also start from an empty one or import a JSON file.'}
            </p>
          </div>
          <div class="row">
            <button class="btn small" onClick={() => api.commit((proj) => proj.taxonomies.push({ name: `taxonomy_${proj.taxonomies.length + 1}`, description: '', items: [] }))}>
              Add empty
            </button>
            <label class="btn small" style={{ cursor: 'pointer' }}>
              Import JSON
              <input type="file" accept=".json" hidden onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (!f) return;
                try {
                  const data = JSON.parse(await f.text());
                  const items: TaxNode[] = Array.isArray(data) ? data : data.categories ?? data.items;
                  if (!Array.isArray(items)) throw new Error('expected an array of categories');
                  api.commit((proj) => proj.taxonomies.push({ name: f.name.replace(/\.json$/, ''), description: data.description ?? '', items }));
                } catch (err) {
                  api.log(`Couldn't import ${f.name}: ${(err as Error).message}`);
                }
              }} />
            </label>
            <button class="btn small primary" disabled={!p.taxonomies.length} onClick={() => api.goto(2)}>Next: classify →</button>
          </div>
        </div>
        {p.taxonomies.map((t) => (
          <TaxonomyEditor api={api} taxonomy={t} />
        ))}
      </div>
    </div>
  );
}

function TaxonomyEditor({ api, taxonomy: t }: { api: Api; taxonomy: Taxonomy }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const leaves = collectLeafItems(t.items).length;

  function rename(name: string) {
    if (!name || name === t.name || api.project.taxonomies.some((x) => x.name === name)) return;
    api.commit((p) => {
      for (const results of Object.values(p.results))
        for (const paper of Object.values(results))
          if (t.name in paper) {
            paper[name] = paper[t.name];
            delete paper[t.name];
          }
      t.name = name;
      updateConsensus(p);
    });
  }

  return (
    <div class="frame stack">
      <div class="spread">
        <div class="row" style={{ flex: 1 }}>
          <input type="text" value={t.name} onChange={(e) => rename(e.currentTarget.value.trim())} style={{ maxWidth: '320px', fontWeight: 500 }} aria-label="Taxonomy name" />
          <span class="small muted">{leaves} leaf categories</span>
        </div>
        <div class="row">
          <button class="btn small ghost" onClick={() => setRaw(raw === null ? JSON.stringify(t.items, null, 2) : null)}>{raw === null ? 'Edit JSON' : 'Close JSON'}</button>
          <button class="btn small ghost" onClick={() => confirm(`Delete taxonomy "${t.name}"?`) && api.commit((p) => {
            p.taxonomies = p.taxonomies.filter((x) => x !== t);
            for (const results of Object.values(p.results)) for (const paper of Object.values(results)) delete paper[t.name];
            updateConsensus(p);
          })}>Delete</button>
        </div>
      </div>
      <input type="text" placeholder="One-sentence description of this organizing angle" value={t.description} onChange={(e) => api.commit(() => (t.description = e.currentTarget.value))} />
      {raw !== null ? (
        <>
          <textarea rows={16} value={raw} onInput={(e) => setRaw(e.currentTarget.value)} />
          <div class="row">
            <button class="btn small primary" onClick={() => {
              try {
                const items = JSON.parse(raw);
                if (!Array.isArray(items)) throw new Error('Expected a JSON array of categories');
                api.commit((p) => {
                  t.items = items;
                  updateConsensus(p);
                });
                setRaw(null);
                setErr(null);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}>Apply</button>
            {err && <span class="small" style={{ color: 'var(--bad)' }}>{err}</span>}
          </div>
        </>
      ) : (
        <>
          <Tree items={t.items} api={api} />
          <div>
            <button class="btn small" onClick={() => api.commit(() => t.items.push({ chapter: String(t.items.length + 1), name: 'new_category', description: '', items: [] }))}>
              Add top-level category
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Taxonomy tree; editable when `api` is given, read-only otherwise. */
function Tree({ items, api, root = true }: { items: TaxNode[]; api?: Api; root?: boolean }) {
  return (
    <ul class={`tree${root ? ' root' : ''}`}>
      {items.map((node) => (
        <TreeNode node={node} siblings={items} api={api} />
      ))}
    </ul>
  );
}

function TreeNode({ node, siblings, api }: { node: TaxNode; siblings: TaxNode[]; api?: Api }) {
  const [open, setOpen] = useState(false);
  const isLeaf = !node.items?.length;
  const edit = (f: () => void) => api?.commit(f);

  return (
    <li class="node">
      <div class="node-head">
        <span class="chapter">{node.chapter}</span>
        {api ? (
          <input type="text" value={node.name} onChange={(e) => edit(() => (node.name = e.currentTarget.value.trim()))} style={{ flex: 1, maxWidth: '360px' }} aria-label="Category name" />
        ) : (
          <span style={{ fontSize: '0.9rem' }}>{node.name}</span>
        )}
        {isLeaf && <span class="mono">leaf</span>}
        <button class="btn small ghost" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
        {api && (
          <>
            <button class="x" title="Add subcategory" aria-label="Add subcategory" onClick={() => edit(() => {
              node.items = node.items ?? [];
              node.items.push({ chapter: `${node.chapter ?? ''}.${node.items.length + 1}`, name: 'new_category', description: '', phrases: [], hard_negative: '' });
            })}>+</button>
            <button class="x" title="Delete category" aria-label="Delete category" onClick={() => confirm(`Delete "${node.name}"${node.items?.length ? ' and its subcategories' : ''}?`) && edit(() => siblings.splice(siblings.indexOf(node), 1))}>×</button>
          </>
        )}
      </div>
      {open && (
        <div class="node-body">
          {api ? (
            <>
              <label class="field">
                <span class="mono">Chapter</span>
                <input type="text" value={node.chapter ?? ''} onChange={(e) => edit(() => (node.chapter = e.currentTarget.value.trim()))} style={{ maxWidth: '120px' }} />
              </label>
              <label class="field">
                <span class="mono">Description</span>
                <textarea rows={2} value={node.description ?? ''} onChange={(e) => edit(() => (node.description = e.currentTarget.value))} />
              </label>
              {isLeaf && (
                <>
                  <label class="field">
                    <span class="mono">Key phrases (comma-separated)</span>
                    <input type="text" value={(node.phrases ?? []).join(', ')} onChange={(e) => edit(() => (node.phrases = e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean)))} />
                  </label>
                  <label class="field">
                    <span class="mono">Hard negative (what does not belong)</span>
                    <textarea rows={2} value={node.hard_negative ?? ''} onChange={(e) => edit(() => (node.hard_negative = e.currentTarget.value))} />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              {node.description && <div class="small">{node.description}</div>}
              {node.phrases?.length ? <div class="small muted">Phrases: {node.phrases.join(', ')}</div> : null}
              {node.hard_negative && <div class="small muted">Not: {node.hard_negative}</div>}
            </>
          )}
        </div>
      )}
      {node.items?.length ? <Tree items={node.items} api={api} root={false} /> : null}
    </li>
  );
}
