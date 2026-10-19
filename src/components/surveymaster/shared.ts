// What the app shell hands to each step component.
import type { ModelInfo } from '../../surveymaster/llm';
import type { Project } from '../../surveymaster/types';

export interface JobCtx {
  key: string;
  signal: AbortSignal;
  onUsage: (prompt: number, completion: number, model: string) => void;
  onRetry: (message: string) => void;
}

export interface Api {
  project: Project;
  /** Apply a change to the project, re-render and schedule a save. */
  commit: (mutate?: (p: Project) => void) => void;
  /** Run one LLM job at a time; it gets the key, an abort signal and usage tracking. */
  run: (label: string, job: (ctx: JobCtx) => Promise<void>) => Promise<void>;
  busy: string | null;
  hasKey: boolean;
  askKey: () => void;
  log: (message: string) => void;
  goto: (step: number) => void;
  models: Map<string, ModelInfo>;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
export const fmtUsd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const shortModel = (m: string) => m.split('/').pop() ?? m;

/** "free" or "$0.30 / $1.20 per M" for a model id. */
export function priceLabel(models: Map<string, ModelInfo>, id: string) {
  const m = models.get(id);
  if (!m) return models.size ? 'not on OpenRouter' : '';
  if (m.prompt === 0 && m.completion === 0) return 'free';
  return `$${(m.prompt * 1e6).toFixed(2)} / $${(m.completion * 1e6).toFixed(2)} per M tokens`;
}

/** Rough token count for prompt-size estimates (about 4 characters per token). */
export const approxTokens = (chars: number) => Math.ceil(chars / 4);
