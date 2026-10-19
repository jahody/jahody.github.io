// OpenRouter client for the browser: the port of call_llm / classify_one / fetch_all_pricing.
// Calls go straight from the visitor's browser to openrouter.ai with the visitor's own key.

export const OPENROUTER = 'https://openrouter.ai/api/v1';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface CallOptions {
  key: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  seed?: number;
  signal?: AbortSignal;
  onUsage?: (prompt: number, completion: number, model: string) => void;
  onRetry?: (message: string) => void;
}

/** Parse JSON from an LLM response, stripping markdown fences if present (parse_json_response). */
export function parseJsonResponse(text: string | null | undefined): unknown {
  if (!text) throw new SyntaxError('Empty or null response from model');
  let t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m) t = m[1];
  return JSON.parse(t);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

async function chatOnce(o: CallOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
    temperature: o.temperature,
    max_tokens: o.maxTokens,
    response_format: { type: 'json_object' },
  };
  if (o.seed !== undefined) body.seed = o.seed;

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${o.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://jahody.github.io/surveymaster/',
        'X-Title': 'SurveyMaster',
      },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new LlmError(`Network error: ${(e as Error).message}`, 0, true);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok || data?.error) {
    const status = res.ok ? Number(data?.error?.code) || 500 : res.status;
    const msg = data?.error?.message ?? (text.slice(0, 200) || res.statusText);
    throw new LlmError(`${status}: ${msg}`, status, status === 408 || status === 429 || status >= 500);
  }
  const choice = data?.choices?.[0];
  if (choice?.error) {
    const status = Number(choice.error.code) || 500;
    throw new LlmError(`${status}: ${choice.error.message}`, status, status === 429 || status >= 500);
  }
  if (data?.usage) o.onUsage?.(data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0, o.model);
  return choice?.message?.content ?? '';
}

/**
 * One JSON-mode call with retries. Rate limits and server errors back off exponentially
 * (2 s, 4 s, 8 s, 16 s, as in the Python retry loop but with more attempts, since free models
 * hit 429 often); unparseable JSON is retried twice after 1 s.
 */
export async function callJson(o: CallOptions): Promise<unknown> {
  let parseFailures = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return parseJsonResponse(await chatOnce(o));
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      if (e instanceof LlmError && e.retryable && attempt < 5) {
        const delay = 2 ** (attempt + 1) * 1000;
        o.onRetry?.(`${o.model}: ${e.message.slice(0, 80)}, retrying in ${delay / 1000}s`);
        await sleep(delay, o.signal);
        continue;
      }
      if (e instanceof SyntaxError && parseFailures < 2) {
        parseFailures++;
        o.onRetry?.(`${o.model}: invalid JSON, retrying`);
        await sleep(1000, o.signal);
        continue;
      }
      throw e;
    }
  }
  throw new LlmError(`Max retries exceeded for ${o.model}`);
}

/** Runs at most `n` tasks at once (the asyncio.Semaphore in 3_classify.py). */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface ModelInfo {
  id: string;
  name: string;
  /** USD per token */
  prompt: number;
  completion: number;
  context: number;
}

let modelsCache: Promise<ModelInfo[]> | null = null;

/** Model catalogue with per-token pricing (fetch_all_pricing). Public endpoint, no key needed. */
export function fetchModels(): Promise<ModelInfo[]> {
  modelsCache ??= fetch(`${OPENROUTER}/models`)
    .then((r) => r.json())
    .then((d) =>
      (d.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        prompt: Number(m.pricing?.prompt ?? 0),
        completion: Number(m.pricing?.completion ?? 0),
        context: Number(m.context_length ?? 0),
      })),
    )
    .catch(() => {
      modelsCache = null;
      return [];
    });
  return modelsCache;
}

export interface KeyInfo {
  label: string;
  usage: number;
  limit: number | null;
  isFreeTier: boolean;
}

/** Checks a key and reports its credit status, which decides the free-model daily limit. */
export async function checkKey(key: string): Promise<KeyInfo> {
  const r = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new LlmError(r.status === 401 ? 'Key not recognised by OpenRouter' : `Key check failed (${r.status})`, r.status);
  const d = (await r.json()).data ?? {};
  return { label: d.label ?? '', usage: Number(d.usage ?? 0), limit: d.limit ?? null, isFreeTier: Boolean(d.is_free_tier) };
}
