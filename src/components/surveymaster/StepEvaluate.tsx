import { useState } from 'preact/hooks';
import { refineTaxonomies, type Metrics, type RefineStep, type Verdict } from '../../surveymaster/evaluate';
import type { Taxonomy } from '../../surveymaster/types';
import { shortModel, type Api } from './shared';

const REFINABLE = ['m1', 'm2', 'm3', 'm4', 'm6', 'm7', 'm8'];

export default function StepEvaluate({ api, metrics }: { api: Api; metrics: Metrics | null }) {
  const p = api.project;
  const [proposal, setProposal] = useState<{ taxonomies: Taxonomy[]; steps: RefineStep[] } | null>(null);

  if (!metrics)
    return (
      <div class="panel">
        <p class="small muted">Metrics appear once papers are classified (step 3).</p>
        <button class="btn small" onClick={() => api.goto(2)}>Go to classify</button>
      </div>
    );

  const verdicts = Object.values(metrics.verdicts);
  const failing = verdicts.filter((v) => !v.passed && REFINABLE.includes(v.id));

  function refine() {
    api.run('Refining taxonomies', async (ctx) => {
      const out = await refineTaxonomies(p, metrics!, p.settings, ctx, (s) =>
        api.log(s.error ? `${s.taxonomy} (${s.phase}) failed: ${s.error}` : `${s.taxonomy} (${s.phase}): ${s.oldLeaves} → ${s.newLeaves} leaves`),
      );
      setProposal(out);
    });
  }

  function accept() {
    if (!proposal) return;
    api.commit((proj) => {
      proj.taxonomies = proposal.taxonomies;
      proj.results = {};
      proj.consensus = {};
      proj.evolution = undefined;
    });
    setProposal(null);
    api.goto(2);
  }

  return (
    <div class="stack">
      <div class="spread">
        <div class="mono">
          {verdicts.filter((v) => v.passed).length} of {verdicts.length} checks pass · {metrics.metadata.n_papers} papers · {metrics.metadata.n_models} models
        </div>
        <button class="btn small" onClick={() => download(`${p.topic}-metrics.json`, metrics)}>Download metrics JSON</button>
      </div>

      <div class="grid3">
        {verdicts.map((v) => <VerdictCard v={v} />)}
      </div>

      {failing.length > 0 && (
        <div class="panel stack">
          <div class="spread">
            <div>
              <div class="mono">Refine</div>
              <p class="small muted" style={{ margin: '4px 0 0' }}>
                The refiner ({shortModel(p.settings.refiner)}) rebalances taxonomies with dead or overloaded leaves (M7), sharpens category boundaries where models
                disagree (M1–M4, M6) and redesigns one of each redundant pair (M8). You review the result before anything changes.
              </p>
            </div>
            <button class="btn primary" disabled={!!api.busy} onClick={refine}>Refine taxonomies</button>
          </div>
          {!api.hasKey && <div class="note">Needs an OpenRouter key. <button class="link" onClick={api.askKey}>Add one</button></div>}
          {proposal && (
            <div class="frame stack">
              <table>
                <thead>
                  <tr><th>Taxonomy</th><th>Fix</th><th>Leaves</th><th>Added</th><th>Removed</th></tr>
                </thead>
                <tbody>
                  {proposal.steps.map((s) => (
                    <tr>
                      <td>{s.taxonomy}</td>
                      <td class="num">{s.phase}</td>
                      <td class="num">{s.error ? 'failed' : `${s.oldLeaves} → ${s.newLeaves}`}</td>
                      <td class="small">{s.error ?? (s.added.slice(0, 6).join(', ') + (s.added.length > 6 ? '…' : '') || '—')}</td>
                      <td class="small">{s.removed.slice(0, 6).join(', ') + (s.removed.length > 6 ? '…' : '') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div class="row">
                <button class="btn primary" disabled={!proposal.steps.some((s) => !s.error)} onClick={accept}>Use refined taxonomies and reclassify</button>
                <button class="btn" onClick={() => setProposal(null)}>Discard</button>
                <span class="small muted">Accepting clears the current classifications.</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div class="grid2">
        <div class="panel stack">
          <div class="mono">Model agreement (top-1)</div>
          <Heatmap names={metrics.pairwise_agreement.model_names.map(shortModel)} matrix={metrics.pairwise_agreement.matrix} />
          <div class="small muted">
            Fleiss' κ {metrics.fleiss_kappa.overall.toFixed(3)} over {metrics.fleiss_kappa.n_items_overall} paper × taxonomy items.
          </div>
        </div>
        <div class="panel stack">
          <div class="mono">Deviation from consensus</div>
          {Object.entries(metrics.model_deviation.models).map(([m, s]: [string, any]) => (
            <Bar label={shortModel(m)} value={s.deviation_rate} max={1} text={`${(s.deviation_rate * 100).toFixed(1)}%`} />
          ))}
          <div class="small muted">Share of a model's top choices that differ from the consensus winner.</div>
        </div>
      </div>

      {Object.entries(metrics.coverage_analysis).map(([tax, info]: [string, any]) => {
        const max = Math.max(1, ...Object.values(info.per_leaf).map((l: any) => l.count));
        return (
          <div class="panel stack">
            <div class="spread">
              <div class="mono">Coverage · {tax}</div>
              <div class="small muted">
                {info.n_leaves} leaves · mean {info.mean_papers_per_leaf} papers · Gini {info.gini} · entropy {info.normalized_entropy}
              </div>
            </div>
            <div class="stack" style={{ gap: '5px' }}>
              {Object.entries(info.per_leaf).map(([ch, l]: [string, any]) => (
                <Bar label={`${ch} ${String(l.name).replace(/_/g, ' ')}`} value={l.count} max={max} text={`${l.count}${l.dead ? ' · dead' : l.fat ? ' · overloaded' : ''}`} dashed={l.dead} />
              ))}
            </div>
          </div>
        );
      })}

      {metrics.taxonomy_independence.taxonomy_names.length > 1 && (
        <div class="panel stack">
          <div class="mono">Taxonomy independence (Cramér's V)</div>
          <Heatmap names={metrics.taxonomy_independence.taxonomy_names} matrix={metrics.taxonomy_independence.matrix} />
          <div class="small muted">Values above 0.7 mean two taxonomies sort papers almost the same way.</div>
        </div>
      )}
    </div>
  );
}

function VerdictCard({ v }: { v: Verdict }) {
  const value =
    v.value === null ? '' : ['m2', 'm3', 'm5', 'm6'].includes(v.id) ? `${(v.value * 100).toFixed(0)}%` : v.value.toFixed(3);
  return (
    <div class="metric">
      <div class="spread">
        <span class="mono">{v.id.toUpperCase()} · {v.group}</span>
        <span class={`badge ${v.passed ? 'pass' : 'fail'}`}>{v.passed ? 'Pass' : 'Fail'}</span>
      </div>
      <div style={{ fontWeight: 500 }}>{v.name}</div>
      {value && <div class="value">{value}</div>}
      <div class="detail">{v.detail}</div>
      {v.action && <div class="action">{v.action}</div>}
    </div>
  );
}

function Bar({ label, value, max, text, dashed }: { label: string; value: number; max: number; text: string; dashed?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr) auto', gap: '10px', alignItems: 'center' }}>
      <span class="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
      <span style={{ height: '10px', border: dashed ? '1px dashed var(--dash)' : '1px solid var(--line)', position: 'relative' }}>
        <i style={{ position: 'absolute', inset: '0 auto 0 0', width: `${(value / max) * 100}%`, background: 'var(--fg)' }} />
      </span>
      <span class="num muted">{text}</span>
    </div>
  );
}

/** Square matrix with grey levels; 1.0 is black. */
function Heatmap({ names, matrix }: { names: string[]; matrix: number[][] }) {
  const n = names.length;
  const cell = 46;
  const label = 150;
  const size = label + n * cell;
  return (
    <svg viewBox={`0 0 ${size} ${n * cell + 4}`} style={{ width: '100%', maxWidth: `${size}px` }} role="img" aria-label="Agreement matrix">
      {names.map((name, i) => (
        <text x={label - 8} y={i * cell + cell / 2 + 4} font-size="11" text-anchor="end" fill="var(--muted)">
          {name.length > 20 ? name.slice(0, 19) + '…' : name}
        </text>
      ))}
      {matrix.map((row, i) =>
        row.map((v, j) => {
          const shade = Math.round(245 - v * 230);
          return (
            <g>
              <rect x={label + j * cell} y={i * cell} width={cell - 2} height={cell - 2} fill={`rgb(${shade},${shade},${shade + 2})`} />
              <text x={label + j * cell + cell / 2 - 1} y={i * cell + cell / 2 + 3} font-size="11" text-anchor="middle" fill={v > 0.55 ? '#fff' : 'var(--fg)'}>
                {v.toFixed(2)}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

function download(name: string, data: unknown) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name.replace(/[^a-z0-9.-]+/gi, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
