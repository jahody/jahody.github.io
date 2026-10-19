import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { updateConsensus } from '../../surveymaster/classify';
import { computeMetrics } from '../../surveymaster/evaluate';
import { checkKey, fetchModels, type KeyInfo, type ModelInfo } from '../../surveymaster/llm';
import {
  deleteProject, exportProject, getCurrentId, getKey, isProject, keyRemembered, listProjects, loadProject,
  saveProject, setCurrentId, setKey, type ProjectSummary,
} from '../../surveymaster/store';
import { DEFAULT_SETTINGS, newProject, type Project } from '../../surveymaster/types';
import './app.css';
import { fmtTokens, fmtUsd, priceLabel, type Api, type JobCtx } from './shared';
import StepClassify from './StepClassify';
import StepEvaluate from './StepEvaluate';
import StepEvolution from './StepEvolution';
import StepPapers from './StepPapers';
import StepTaxonomies from './StepTaxonomies';

const STEPS = ['Papers', 'Taxonomies', 'Classify', 'Evaluate', 'Evolution'];
const DEMO_BASE = '/surveymaster/demo/';

interface DemoEntry {
  file: string;
  topic: string;
  papers: number;
  taxonomies: number;
  models: string[];
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Fill in fields added after a project was saved, so older exports still open. */
function normalize(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_SETTINGS, ...p.settings },
    proposals: p.proposals ?? [],
    axes: p.axes ?? [],
    results: p.results ?? {},
    consensus: p.consensus ?? {},
    usage: Object.assign({ prompt: 0, completion: 0, cost: 0, calls: 0 }, p.usage),
  };
}

export default function App() {
  const projectRef = useRef<Project | null>(null);
  const [, setRev] = useState(0);
  const [step, setStep] = useState(0);
  const [key, setKeyValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'key' | 'settings' | null>(null);
  const [models, setModels] = useState<Map<string, ModelInfo>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const project = projectRef.current;

  useEffect(() => {
    setKeyValue(getKey());
    fetchModels().then((ms) => setModels(new Map(ms.map((m) => [m.id, m]))));
    const id = getCurrentId();
    if (id) loadProject(id).then((p) => p && open(p, false));
  }, []);

  const log = (message: string) => setLines((l) => [...l.slice(-199), `${new Date().toLocaleTimeString()}  ${message}`]);

  function scheduleSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => projectRef.current && saveProject(projectRef.current), 600);
  }

  function commit(mutate?: (p: Project) => void) {
    if (!projectRef.current) return;
    mutate?.(projectRef.current);
    setRev((r) => r + 1);
    scheduleSave();
  }

  function open(p: Project, resetStep = true) {
    projectRef.current = normalize(p);
    setCurrentId(p.id);
    setLines([]);
    setError(null);
    if (resetStep) setStep(p.papers.length ? (p.taxonomies.length ? (Object.keys(p.consensus).length ? 3 : 2) : 1) : 0);
    setRev((r) => r + 1);
    scheduleSave();
  }

  function close() {
    abortRef.current?.abort();
    projectRef.current = null;
    setCurrentId(null);
    setPanel(null);
    setRev((r) => r + 1);
  }

  async function run(label: string, job: (ctx: JobCtx) => Promise<void>) {
    if (!key) {
      setPanel('key');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(label);
    setError(null);
    log(`${label}…`);
    const ctx: JobCtx = {
      key,
      signal: controller.signal,
      onUsage: (prompt, completion, model) => {
        const price = models.get(model);
        commit((p) => {
          p.usage.prompt += prompt;
          p.usage.completion += completion;
          p.usage.calls += 1;
          p.usage.cost += price ? prompt * price.prompt + completion * price.completion : 0;
        });
      },
      onRetry: log,
    };
    try {
      await job(ctx);
      log(`${label}: done`);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') log(`${label}: stopped`);
      else {
        setError(`${label} failed: ${err.message}`);
        log(`${label} failed: ${err.message}`);
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
      commit();
      if (projectRef.current) saveProject(projectRef.current);
    }
  }

  const metrics = useMemo(
    () => (project && Object.keys(project.consensus).length && project.taxonomies.length ? computeMetrics(project) : null),
    [project, project && project.consensus],
  );

  if (!project)
    return (
      <div class="sm">
        <Start onOpen={open} />
      </div>
    );

  const api: Api = {
    project,
    commit,
    run,
    busy,
    hasKey: Boolean(key),
    askKey: () => setPanel('key'),
    log,
    goto: setStep,
    models,
  };

  const total = project.papers.length * project.taxonomies.length * project.settings.models.length;
  const done = project.settings.models.reduce(
    (n, m) => n + project.papers.reduce((k, p) => k + project.taxonomies.filter((t) => { const r = project.results[m]?.[p.id]?.[t.name]; return r && !r.error; }).length, 0),
    0,
  );
  const passed = metrics ? Object.values(metrics.verdicts).filter((v) => v.passed).length : 0;
  const missing = [...new Set([...project.settings.models, project.settings.refiner])].filter((m) => m && !models.has(m));
  const states = [
    `${project.papers.length} papers`,
    project.taxonomies.length ? `${project.taxonomies.length} taxonom${project.taxonomies.length === 1 ? 'y' : 'ies'}` : project.proposals.length ? `${project.proposals.length} proposals` : 'not built',
    total ? `${done} / ${total} results` : 'waiting',
    metrics ? `${passed} of 8 pass` : 'waiting',
    project.evolution ? `${project.evolution.edges.length} edges` : 'not built',
  ];
  const doneFlags = [project.papers.length > 0, project.taxonomies.length > 0, total > 0 && done === total, Boolean(metrics), Boolean(project.evolution)];

  return (
    <div class="sm">
      <div class="topbar">
        <div>
          <div class="mono">{project.source === 'demo' ? 'Demo project' : 'Project'} · saved in this browser</div>
          <h2>{project.topic}</h2>
          <div class="small muted">
            {project.usage.calls ? `${project.usage.calls} calls · ${fmtTokens(project.usage.prompt + project.usage.completion)} tokens · ${fmtUsd(project.usage.cost)}` : 'No LLM calls yet'}
          </div>
        </div>
        <div class="row">
          <button class="btn small" onClick={() => setPanel(panel === 'key' ? null : 'key')}>
            {key ? 'API key ■' : 'Add API key'}
          </button>
          <button class="btn small" onClick={() => setPanel(panel === 'settings' ? null : 'settings')}>Models and settings</button>
          <button class="btn small" onClick={() => exportProject(project)}>Export</button>
          <button class="btn small" onClick={close}>Close</button>
        </div>
      </div>

      {panel === 'key' && (
        <KeyPanel
          value={key}
          onSave={(k, remember) => {
            setKey(k, remember);
            setKeyValue(k);
            if (k) setPanel(null);
          }}
        />
      )}
      {panel === 'settings' && <SettingsPanel api={api} />}

      <nav class="steps" aria-label="Pipeline steps">
        {STEPS.map((name, i) => (
          <button aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
            <span class="mono">{String(i + 1).padStart(2, '0')}</span>
            <span class="name">{name}</span>
            <span class={`state${doneFlags[i] ? ' done' : ''}`}>{states[i]}</span>
          </button>
        ))}
      </nav>

      {busy && (
        <div class="spread note">
          <span>{busy}…</span>
          <button class="btn small" onClick={() => abortRef.current?.abort()}>Stop</button>
        </div>
      )}
      {models.size > 0 && missing.length > 0 && (
        <div class="spread note warn">
          <span>
            Not available on OpenRouter any more: {missing.join(', ')}. Pick replacements before running new calls.
          </span>
          <button class="btn small" onClick={() => setPanel('settings')}>Models and settings</button>
        </div>
      )}
      {error && (
        <div class="spread note bad">
          <span>{error}</span>
          <button class="x" aria-label="Dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {step === 0 && <StepPapers api={api} />}
      {step === 1 && <StepTaxonomies api={api} />}
      {step === 2 && <StepClassify api={api} />}
      {step === 3 && <StepEvaluate api={api} metrics={metrics} />}
      {step === 4 && <StepEvolution api={api} />}

      {lines.length > 0 && <div class="log">{lines.join('\n')}</div>}
    </div>
  );
}

function Start({ onOpen }: { onOpen: (p: Project) => void }) {
  const [demos, setDemos] = useState<DemoEntry[]>([]);
  const [saved, setSaved] = useState<ProjectSummary[]>([]);
  const [topic, setTopic] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${DEMO_BASE}index.json`).then((r) => r.json()).then(setDemos).catch(() => setDemos([]));
    listProjects().then(setSaved);
  }, []);

  async function openDemo(d: DemoEntry) {
    setMsg(`Loading ${d.topic}…`);
    try {
      const p = (await fetch(DEMO_BASE + d.file).then((r) => r.json())) as Project;
      updateConsensus(p);
      onOpen({ ...p, id: newId(), createdAt: new Date().toISOString() });
    } catch (e) {
      setMsg(`Couldn't load the demo: ${(e as Error).message}`);
    }
  }

  async function importFile(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (!isProject(data)) throw new Error('not a SurveyMaster project export');
      onOpen({ ...data, id: newId() });
    } catch (e) {
      setMsg(`Couldn't import ${file.name}: ${(e as Error).message}`);
    }
  }

  return (
    <>
      <div class="grid2">
        <div class="panel stack">
          <div class="mono">Open a finished run · no key needed</div>
          <p class="small muted">
            Three topics classified earlier with the Python pipeline (DeepSeek V3.2, Gemini 3.1 Flash Lite, GPT-5 nano). Every stage is filled
            in, and evaluation runs in your browser.
          </p>
          <ul class="list">
            {demos.map((d) => (
              <li>
                <span class="grow">
                  <button class="link" onClick={() => openDemo(d)}>{d.topic}</button>
                </span>
                <span class="num muted">{d.papers} papers</span>
              </li>
            ))}
            {!demos.length && <li class="muted small">Loading demos…</li>}
          </ul>
        </div>
        <div class="panel stack">
          <div class="mono">Start your own · needs an OpenRouter key</div>
          <p class="small muted">Find papers on a topic, design taxonomies with several models, classify, evaluate and map how the work evolved.</p>
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (topic.trim()) onOpen(newProject(topic.trim(), 'openalex'));
            }}
          >
            <input type="text" placeholder="Topic, e.g. speculative decoding" value={topic} onInput={(e) => setTopic(e.currentTarget.value)} style={{ flex: 1 }} />
            <button class="btn primary" type="submit" disabled={!topic.trim()}>Start</button>
          </form>
          <label class="small muted">
            Or import an exported project:{' '}
            <input type="file" accept="application/json,.json" onChange={(e) => e.currentTarget.files?.[0] && importFile(e.currentTarget.files[0])} />
          </label>
        </div>
      </div>
      {saved.length > 0 && (
        <div class="panel stack">
          <div class="mono">Saved in this browser</div>
          <ul class="list">
            {saved.map((s) => (
              <li>
                <span class="grow">
                  <button class="link" onClick={() => loadProject(s.id).then((p) => p && onOpen(p))}>{s.topic}</button>
                  <span class="small muted"> · {s.papers} papers · {s.taxonomies} taxonomies · {new Date(s.createdAt).toLocaleDateString()}</span>
                </span>
                <button
                  class="x"
                  aria-label={`Delete ${s.topic}`}
                  onClick={async () => {
                    if (!confirm(`Delete "${s.topic}" from this browser?`)) return;
                    await deleteProject(s.id);
                    setSaved(await listProjects());
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg && <div class="note">{msg}</div>}
    </>
  );
}

function KeyPanel({ value, onSave }: { value: string; onSave: (key: string, remember: boolean) => void }) {
  const [k, setK] = useState(value);
  const [remember, setRemember] = useState(keyRemembered());
  const [info, setInfo] = useState<string | null>(null);

  async function check() {
    setInfo('Checking…');
    try {
      const i: KeyInfo = await checkKey(k.trim());
      setInfo(
        `Key works${i.label ? ` (${i.label})` : ''}. ` +
          (i.isFreeTier
            ? 'This account has no purchased credits, so OpenRouter caps free models at a small number of requests per day; a full run may need credits or a smaller paper set.'
            : `Usage so far: $${i.usage.toFixed(2)}${i.limit !== null ? ` of $${Number(i.limit).toFixed(2)}` : ''}.`),
      );
    } catch (e) {
      setInfo((e as Error).message);
    }
  }

  return (
    <div class="panel stack">
      <div class="mono">OpenRouter API key</div>
      <p class="small muted">
        Every LLM call goes straight from this page to openrouter.ai with your key. It is kept in this browser only (this tab, or this device if you tick
        "remember") and never sent anywhere else. Create one at{' '}
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a>.
      </p>
      <div class="row">
        <input type="password" placeholder="sk-or-v1-…" value={k} onInput={(e) => setK(e.currentTarget.value)} style={{ flex: 1, minWidth: '220px' }} autocomplete="off" />
        <button class="btn small" onClick={check} disabled={!k.trim()}>Check</button>
        <button class="btn small primary" onClick={() => onSave(k.trim(), remember)}>{k.trim() ? 'Use key' : 'Forget key'}</button>
      </div>
      <label class="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /> Remember on this device
      </label>
      {info && <div class="small">{info}</div>}
    </div>
  );
}

function SettingsPanel({ api }: { api: Api }) {
  const s = api.project.settings;
  const set = (patch: Partial<typeof s>) =>
    api.commit((p) => {
      Object.assign(p.settings, patch);
      if (patch.models) updateConsensus(p);
    });
  const ids = [...api.models.keys()].sort();
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

  return (
    <div class="panel stack">
      <div class="mono">Models and settings</div>
      <datalist id="sm-models">
        {ids.map((id) => <option value={id} />)}
      </datalist>
      <div class="grid2">
        <div class="stack">
          <div class="small muted">Voting models: each one classifies every paper and proposes taxonomies.</div>
          {s.models.map((m, i) => (
            <div class="row">
              <input type="text" list="sm-models" value={m} onChange={(e) => set({ models: s.models.map((x, j) => (j === i ? e.currentTarget.value.trim() : x)) })} style={{ flex: 1 }} />
              <span class="small muted" style={{ minWidth: '80px' }}>{priceLabel(api.models, m)}</span>
              <button class="x" aria-label="Remove model" onClick={() => set({ models: s.models.filter((_, j) => j !== i) })} disabled={s.models.length <= 1}>×</button>
            </div>
          ))}
          <div class="row">
            <button class="btn small" onClick={() => set({ models: [...s.models, ''] })}>Add model</button>
            <button class="btn small ghost" onClick={() => set({ models: [...DEFAULT_SETTINGS.models], refiner: DEFAULT_SETTINGS.refiner })}>Use free models</button>
          </div>
          <label class="field">
            <span class="mono">Refiner model (merges proposals, fixes taxonomies)</span>
            <input type="text" list="sm-models" value={s.refiner} onChange={(e) => set({ refiner: e.currentTarget.value.trim() })} />
            <span class="small muted">{priceLabel(api.models, s.refiner)}</span>
          </label>
        </div>
        <div class="grid2" style={{ alignContent: 'start' }}>
          <label class="field">
            <span class="mono">Top-k chapters</span>
            <input type="number" min={1} max={5} value={s.topK} onChange={(e) => set({ topK: num(e.currentTarget.value, 3) })} />
          </label>
          <label class="field">
            <span class="mono">Parallel calls</span>
            <input type="number" min={1} max={20} value={s.concurrency} onChange={(e) => set({ concurrency: num(e.currentTarget.value, 3) })} />
          </label>
          <label class="field">
            <span class="mono">Classify temperature</span>
            <input type="number" step="0.1" min={0} max={2} value={s.classifyTemperature} onChange={(e) => set({ classifyTemperature: num(e.currentTarget.value, 0) })} />
          </label>
          <label class="field">
            <span class="mono">Taxonomy temperature</span>
            <input type="number" step="0.1" min={0} max={2} value={s.generationTemperature} onChange={(e) => set({ generationTemperature: num(e.currentTarget.value, 0.5) })} />
          </label>
          <label class="check" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={s.includeHardNegative} onChange={(e) => set({ includeHardNegative: e.currentTarget.checked })} />
            Show models each category's hard negative
          </label>
        </div>
      </div>
      <p class="small muted">Model changes apply to the next run. Results already collected stay; models you remove drop out of the vote.</p>
    </div>
  );
}
