import { useState } from 'preact/hooks';
import { createChronologicalChunks, runEvolution } from '../../surveymaster/evolve';
import type { EvolutionTree } from '../../surveymaster/types';
import type { Api } from './shared';

const TYPES: Record<string, { label: string; dash?: string; color: string; width: number }> = {
  direct_extension: { label: 'Direct extension', color: 'var(--fg)', width: 1.4 },
  conceptual_influence: { label: 'Conceptual influence', color: '#a3a7ad', width: 1 },
  shared_benchmark: { label: 'Shared benchmark', color: '#a3a7ad', width: 1, dash: '2 3' },
  challenges: { label: 'Challenges', color: '#b42318', width: 1.2, dash: '6 3' },
};

export default function StepEvolution({ api }: { api: Api }) {
  const p = api.project;
  const s = p.settings;
  const chunks = s.chunkSize > 0 && p.papers.length > s.chunkSize ? createChronologicalChunks(p.papers, s.chunkSize, s.chunkOverlap).length : 1;
  const calls = s.models.length * chunks + (s.models.length > 1 ? 1 : 0);

  function build() {
    api.run('Building the evolution tree', async (ctx) => {
      const { tree, removed, isolated } = await runEvolution(p.papers, p.taxonomies, p.consensus, p.topic, s, ctx, api.log);
      api.log(`Kept ${tree.edges.length} edges; dropped ${removed.unknown} with unknown papers, ${removed.chrono} backwards in time, ${removed.duplicate} duplicates. ${isolated.length === 1 ? '1 paper has' : `${isolated.length} papers have`} no edge.`);
      api.commit((proj) => (proj.evolution = tree));
    });
  }

  return (
    <div class="stack">
      <div class="panel stack">
        <div class="spread">
          <div>
            <div class="mono">Evolution tree</div>
            <p class="small muted" style={{ margin: '4px 0 0' }}>
              Each model reads the papers in date order{chunks > 1 ? ` (${chunks} overlapping chunks of ${s.chunkSize})` : ''} and proposes which earlier work each paper
              builds on; the refiner merges the proposals. {calls} calls.
            </p>
          </div>
          <button class={`btn ${p.evolution ? '' : 'primary'}`} disabled={!!api.busy || p.papers.length < 2} onClick={build}>
            {p.evolution ? 'Build again' : 'Build evolution tree'}
          </button>
        </div>
        {!api.hasKey && <div class="note">Needs an OpenRouter key. <button class="link" onClick={api.askKey}>Add one</button></div>}
        {!Object.keys(p.consensus).length && <div class="note">Works without classifications, but with them each paper's categories are passed to the models as context.</div>}
      </div>
      {p.evolution && <TreeView tree={p.evolution} />}
    </div>
  );
}

function TreeView({ tree }: { tree: EvolutionTree }) {
  const [focus, setFocus] = useState<string | null>(null);
  const periods = [...tree.time_periods.map((t) => t.id), ...(tree.nodes.some((n) => n.time_period === 'Unknown') ? ['Unknown'] : [])];
  const columns = periods.map((id) => tree.nodes.filter((n) => n.time_period === id));
  const colW = 170;
  const rowH = 24;
  const top = 34;
  const height = top + Math.max(1, ...columns.map((c) => c.length)) * rowH + 10;
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, i) => col.forEach((n, j) => pos.set(n.arxiv, { x: 14 + i * colW, y: top + j * rowH + 8 })));
  const name = new Map(tree.nodes.map((n) => [n.arxiv, n.name]));
  const related = focus ? tree.edges.filter((e) => e.source === focus || e.target === focus) : [];
  const near = new Set(related.flatMap((e) => [e.source, e.target]));

  return (
    <div class="panel stack">
      <div class="spread">
        <div class="mono">{tree.nodes.length} papers · {tree.edges.length} edges</div>
        <div class="row small">
          {Object.entries(TYPES).map(([, t]) => (
            <span class="row" style={{ gap: '6px' }}>
              <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke={t.color} stroke-width={t.width + 0.4} stroke-dasharray={t.dash} /></svg>
              <span class="muted">{t.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg width={periods.length * colW + 20} height={height} role="img" aria-label="Evolution tree by time period">
          {periods.map((id, i) => (
            <>
              <text x={14 + i * colW} y={14} font-size="10" fill="var(--muted)">{tree.time_periods.find((t) => t.id === id)?.label ?? id}</text>
              {i > 0 && <line x1={i * colW + 4} y1={0} x2={i * colW + 4} y2={height} stroke="var(--line)" />}
            </>
          ))}
          {tree.edges.map((e) => {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) return null;
            const t = TYPES[e.type] ?? TYPES.conceptual_influence;
            const dim = focus && !(e.source === focus || e.target === focus);
            const mx = (a.x + b.x) / 2;
            return (
              <path
                d={a.x === b.x ? `M${a.x} ${a.y} C${a.x - 40} ${a.y}, ${b.x - 40} ${b.y}, ${b.x} ${b.y}` : `M${a.x} ${a.y} C${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`}
                fill="none"
                stroke={t.color}
                stroke-width={t.width}
                stroke-dasharray={t.dash}
                opacity={dim ? 0.08 : focus ? 1 : 0.55}
              >
                <title>{`${name.get(e.source)} → ${name.get(e.target)}${e.label ? `: ${e.label}` : ''}`}</title>
              </path>
            );
          })}
          {tree.nodes.map((n) => {
            const q = pos.get(n.arxiv);
            if (!q) return null;
            const on = focus === n.arxiv;
            const dim = focus && !near.has(n.arxiv) && !on;
            return (
              <g style={{ cursor: 'pointer' }} opacity={dim ? 0.3 : 1} onClick={() => setFocus(on ? null : n.arxiv)}>
                <circle cx={q.x} cy={q.y} r={on ? 4.5 : 3.2} fill={on ? 'var(--fg)' : 'var(--bg)'} stroke="var(--fg)" stroke-width="1.2" />
                <text x={q.x + 8} y={q.y + 3.5} font-size="10" fill="var(--fg)">{n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name}</text>
                <title>{`${n.name} (${n.arxiv})`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      {focus ? (
        <div class="frame stack" style={{ gap: '6px' }}>
          <div class="spread">
            <strong style={{ fontWeight: 500 }}>{name.get(focus)}</strong>
            <button class="x" aria-label="Clear selection" onClick={() => setFocus(null)}>×</button>
          </div>
          {related.length === 0 && <div class="small muted">No edges for this paper.</div>}
          {related.map((e) => (
            <div class="small">
              {e.source === focus ? 'Influenced → ' : '← Builds on '}
              <button class="link" onClick={() => setFocus(e.source === focus ? e.target : e.source)}>{name.get(e.source === focus ? e.target : e.source)}</button>
              <span class="muted"> · {TYPES[e.type]?.label ?? e.type}{e.label ? ` · ${e.label}` : ''}</span>
            </div>
          ))}
        </div>
      ) : (
        <div class="small muted">Click a paper to see what it builds on and what built on it.</div>
      )}
    </div>
  );
}
