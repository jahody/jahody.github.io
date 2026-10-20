// Browser port of agentswarm/bank.py: tier routing, quota-aware scoring and
// failover over free-tier OpenAI-compatible providers. The page calls the
// providers directly with the user's own keys; no server in between.
//
// State (cooldowns, latency p50, remaining quota, disabled models/providers)
// is one JSON blob in localStorage instead of bank.py's SQLite store.

import { PROVIDERS, TIER_PRIORITY } from './providers.js';

const STATE_KEY = 'agentswarm.state.v1';

// ---------- errors ----------

export class BankError extends Error {}
export class BankExhausted extends BankError {}
class Retryable429 extends BankError {
  constructor(retryAfter, message) { super(message); this.retryAfter = retryAfter; }
}
class RetryableTransient extends BankError {}
class PermanentDisable extends BankError {}

const isAbort = (e) => e?.name === 'AbortError';

// ---------- header parsers (bank.py parse_*) ----------
// The browser only sees headers a provider lists in Access-Control-Expose-Headers,
// so these often return nulls; routing then falls back to tier priority and 429s.

const toInt = (v) => {
  if (v == null) return null;
  const n = Math.trunc(parseFloat(v));
  return Number.isFinite(n) ? n : null;
};

const PARSERS = {
  cerebras: (h) => ({
    rpm_remaining: toInt(h['x-ratelimit-remaining-requests-minute']),
    rpd_remaining: toInt(h['x-ratelimit-remaining-requests-day']),
    tpm_remaining: toInt(h['x-ratelimit-remaining-tokens-minute']),
    tpd_remaining: toInt(h['x-ratelimit-remaining-tokens-day']),
    rpm_limit: toInt(h['x-ratelimit-limit-requests-minute']),
    rpd_limit: toInt(h['x-ratelimit-limit-requests-day']),
    tpm_limit: toInt(h['x-ratelimit-limit-tokens-minute']),
    tpd_limit: toInt(h['x-ratelimit-limit-tokens-day']),
  }),
  groq: (h) => ({
    rpm_remaining: toInt(h['x-ratelimit-remaining-requests']),
    tpm_remaining: toInt(h['x-ratelimit-remaining-tokens']),
    rpm_limit: toInt(h['x-ratelimit-limit-requests']),
    tpm_limit: toInt(h['x-ratelimit-limit-tokens']),
  }),
  huggingface: (h) => ({
    rpm_remaining: toInt(h['x-ratelimit-remaining-requests']),
    tpm_remaining: toInt(h['x-ratelimit-remaining-tokens']),
    rpm_limit: toInt(h['x-ratelimit-limit-requests']),
    tpm_limit: toInt(h['x-ratelimit-limit-tokens']),
  }),
  openrouter: (h) => ({ rpd_remaining: toInt(h['x-ratelimit-remaining']) }),
  google_ai_studio: () => ({}),
};

function headerDict(headers) {
  const out = {};
  headers?.forEach?.((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

// Lexicographic tuple comparison, descending (Python's sort(reverse=True) on tuples).
function compareDesc(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// ---------- Bank ----------

export class Bank {
  /**
   * @param {object} opts
   * @param {(provider: string) => string} opts.getKey  API key for a provider ('' when unset)
   * @param {Storage} [opts.storage]  where routing state persists (default localStorage)
   * @param {typeof fetch} [opts.fetch]
   * @param {() => number} [opts.now]  seconds since epoch
   */
  constructor({ getKey, providers = PROVIDERS, tierPriority = TIER_PRIORITY, storage, fetch, now } = {}) {
    this.getKey = getKey || (() => '');
    this.providers = providers;
    this.tierPriority = tierPriority;
    this.storage = storage || globalThis.localStorage || memoryStorage();
    this.fetch = fetch || ((...args) => globalThis.fetch(...args));
    this.now = now || (() => Date.now() / 1000);
    this.state = this._load();
  }

  // ---- state ----

  _load() {
    try {
      const s = JSON.parse(this.storage.getItem(STATE_KEY) || 'null');
      if (s && s.live && s.disabled_models && s.disabled_providers) return s;
    } catch { /* corrupt or blocked storage: start fresh */ }
    return { live: {}, disabled_models: {}, disabled_providers: {} };
  }

  _save() {
    try { this.storage.setItem(STATE_KEY, JSON.stringify(this.state)); } catch { /* storage full or blocked */ }
  }

  resetState() {
    this.state = { live: {}, disabled_models: {}, disabled_providers: {} };
    this._save();
  }

  provider(name) {
    return this.providers.find((p) => p.name === name);
  }

  _stateKey(p, m) {
    return p.shared_bucket ? '*' : m.id;
  }

  getState(provider, key) {
    return {
      rpm_remaining: null, rpd_remaining: null, tpm_remaining: null, tpd_remaining: null,
      rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null,
      cooldown_until: 0, last_429_at: 0, last_success_at: 0, updated_at: 0, latency_p50_ms: null,
      ...this.state.live[`${provider}|${key}`],
    };
  }

  _setState(provider, key, s) {
    this.state.live[`${provider}|${key}`] = { ...s, updated_at: this.now() };
    this._save();
  }

  _setCooldown(provider, key, until, on429) {
    const s = this.getState(provider, key);
    s.cooldown_until = until;
    if (on429) s.last_429_at = this.now();
    this._setState(provider, key, s);
  }

  isModelDisabled(provider, modelId) {
    return `${provider}|${modelId}` in this.state.disabled_models;
  }

  modelDisabledReason(provider, modelId) {
    return this.state.disabled_models[`${provider}|${modelId}`] ?? null;
  }

  disableModel(provider, modelId, reason) {
    this.state.disabled_models[`${provider}|${modelId}`] = reason;
    this._save();
  }

  isProviderDisabled(name) {
    return name in this.state.disabled_providers;
  }

  disableProvider(name, reason) {
    this.state.disabled_providers[name] = reason;
    this._save();
  }

  /** Re-enable a provider after its key changed (a 401/403 disables it). */
  enableProvider(name) {
    delete this.state.disabled_providers[name];
    this._save();
  }

  _reconcile(p, m, key, headers, ok, latencyMs = null) {
    const updates = (PARSERS[p.name] || (() => ({})))(headers);
    const cur = this.getState(p.name, key);
    for (const [k, v] of Object.entries(updates)) if (v != null) cur[k] = v;
    if (ok) {
      cur.last_success_at = this.now();
      if (latencyMs != null) {
        cur.latency_p50_ms = cur.latency_p50_ms == null ? latencyMs : 0.8 * cur.latency_p50_ms + 0.2 * latencyMs;
      }
    }
    this._setState(p.name, key, cur);
  }

  // ---- selection (bank.py _score / acquire) ----

  _score(p, m, s, prefer, preferModels, tier) {
    const modelBonus = preferModels?.includes(m.id) ? 2 : 0;
    const preferBonus = prefer?.includes(p.name) ? 1 : 0;
    const rpm = s.rpm_remaining ?? 1_000_000;
    const rpd = s.rpd_remaining ?? 1_000_000;
    const tpm = s.tpm_remaining ?? 1_000_000_000;
    if (tier === 'T3') {
      const p50 = s.latency_p50_ms ?? 999_999;
      return [modelBonus, preferBonus, -p50, rpd, rpm, tpm];
    }
    const idx = (this.tierPriority[tier] || []).indexOf(p.name);
    const prio = idx === -1 ? -999 : -idx;
    return [modelBonus, preferBonus, prio, rpd, rpm, tpm];
  }

  acquire({ tier = null, prefer, preferModels, avoid, avoidModels, minTokens } = {}) {
    const now = this.now();
    avoid = avoid || new Set();
    avoidModels = avoidModels || new Set();
    const candidates = [];
    for (const p of this.providers) {
      if (avoid.has(p.name) || this.isProviderDisabled(p.name)) continue;
      if (!this.getKey(p.name)) continue;
      for (const m of p.models) {
        if (tier != null && m.tier !== tier) continue;
        if (avoidModels.has(m.id)) continue;
        if (this.isModelDisabled(p.name, m.id)) continue;
        const key = this._stateKey(p, m);
        const s = this.getState(p.name, key);
        if (s.cooldown_until > now) continue;
        if (minTokens && s.tpm_remaining != null && s.tpm_remaining < minTokens) continue;
        candidates.push({ score: this._score(p, m, s, prefer, preferModels, m.tier), provider: p, model: m, stateKey: key });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => compareDesc(a.score, b.score));
    const { provider, model, stateKey } = candidates[0];
    return { provider, model, stateKey };
  }

  // Record a failed attempt the way bank.py's except-branches do.
  _applyFailure(lease, err) {
    const { provider: p, model: m, stateKey } = lease;
    if (err instanceof Retryable429) {
      this._setCooldown(p.name, stateKey, this.now() + (err.retryAfter || 60), true);
    } else if (err instanceof RetryableTransient) {
      this._setCooldown(p.name, stateKey, this.now() + 30, false);
    } else if (err instanceof PermanentDisable) {
      this.disableModel(p.name, m.id, err.message);
    }
  }

  // ---- streaming (bank.py stream / _stream_call) ----

  /**
   * Yields answer text as strings, chain-of-thought as {reasoning} objects, then a
   * final {provider, model, latency_ms, ttfb_ms, meta}. Failover only happens
   * before the first byte; mid-stream errors throw.
   */
  async *stream(messages, { tier = null, maxTokens = 1024, prefer, preferModels, avoid, avoidModels, maxFailovers = 4, signal } = {}) {
    if (tier == null && !preferModels?.length) throw new BankError('stream() requires either tier or preferModels');
    const tried = [];
    let avoidSet = new Set(avoid || []);
    let avoidModelsSet = new Set(avoidModels || []);
    const fmtTried = () => tried.map(([p, m, why]) => `${p}/${m} (${why})`).join(', ') || 'none';
    for (let attempts = 1; attempts <= maxFailovers; attempts++) {
      const lease = this.acquire({ tier, prefer, preferModels, avoid: avoidSet, avoidModels: avoidModelsSet, minTokens: maxTokens });
      if (!lease) throw new BankExhausted(`no eligible model for tier=${tier}; tried: ${fmtTried()}`);
      const gen = this._streamCall(lease, messages, maxTokens, signal);
      let first;
      try {
        first = await gen.next();
      } catch (e) {
        if (isAbort(e) || !(e instanceof BankError)) throw e;
        this._applyFailure(lease, e);
        tried.push([lease.provider.name, lease.model.id, e.message]);
        if (e instanceof Retryable429 || e instanceof RetryableTransient) {
          avoidModelsSet = new Set([...avoidModelsSet, lease.model.id]);
        }
        if (e instanceof Retryable429 && lease.provider.shared_bucket) {
          avoidSet = new Set([...avoidSet, lease.provider.name]);
        }
        continue;
      }
      const withAttempts = (v) => (v && typeof v === 'object' && 'provider' in v ? { ...v, meta: { ...v.meta, tier, attempts } } : v);
      if (!first.done) yield withAttempts(first.value);
      for await (const v of gen) yield withAttempts(v);
      return;
    }
    throw new BankExhausted(`stream max_failovers=${maxFailovers} exceeded; tried: ${fmtTried()}`);
  }

  /** One fixed provider/model with no failover (Compare mode). Failures still update state. */
  async *streamModel(providerName, modelId, messages, { maxTokens = 1024, signal } = {}) {
    const p = this.provider(providerName);
    const m = p?.models.find((x) => x.id === modelId);
    if (!m) throw new BankError(`unknown model ${providerName}/${modelId}`);
    const lease = { provider: p, model: m, stateKey: this._stateKey(p, m) };
    try {
      yield* this._streamCall(lease, messages, maxTokens, signal);
    } catch (e) {
      if (!isAbort(e)) this._applyFailure(lease, e);
      throw e;
    }
  }

  async *_streamCall(lease, messages, maxTokens, signal) {
    const { provider: p, model: m, stateKey } = lease;
    const key = this.getKey(p.name);
    if (!key) throw new PermanentDisable(`${p.key_env} not set`);

    // One controller for the user's stop button and our own timeout. The timeout
    // covers time-to-headers, then restarts on every chunk (an idle timeout).
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, p.request_timeout * 1000);
    };
    const userAbort = () => {
      const e = new Error('stopped');
      e.name = 'AbortError';
      return e;
    };

    let reader;
    try {
      arm();
      const t0 = performance.now();
      let res;
      try {
        res = await this.fetch(`${p.base_url}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: m.id, messages, max_tokens: maxTokens, stream: true }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw userAbort();
        throw new RetryableTransient(timedOut ? `timeout after ${p.request_timeout}s` : `network error: ${e.message}`);
      }
      const ttfb = Math.round(performance.now() - t0);
      const headers = headerDict(res.headers);

      if (res.status !== 200) {
        const body = (await res.text().catch(() => '')).slice(0, 400);
        this._reconcile(p, m, stateKey, headers, false);
        const st = res.status;
        if (st === 429) {
          const ra = parseFloat(headers['retry-after']);
          throw new Retryable429(Number.isFinite(ra) ? ra : null, `429 rate limited${Number.isFinite(ra) ? ` (retry after ${ra}s)` : ''}`);
        }
        if (st === 402) throw new Retryable429(86400, '402 payment required');
        if (st === 400) throw new PermanentDisable(`400: ${body.slice(0, 200)}`);
        if (st === 404 || st === 410) throw new PermanentDisable(`${st}: ${body.slice(0, 200)}`);
        if (st === 401 || st === 403) {
          this.disableProvider(p.name, `${st}: auth`);
          throw new PermanentDisable(`${st}: key rejected`);
        }
        if (st >= 500 && st < 600) throw new RetryableTransient(`${st}: ${body.slice(0, 200)}`);
        throw new PermanentDisable(`unhandled ${st}: ${body.slice(0, 200)}`);
      }

      // Stream OK: the time to headers is the latency sample for the p50 EWMA.
      this._reconcile(p, m, stateKey, headers, true, ttfb);
      const usage = {};
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;
      while (!finished) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal?.aborted) throw userAbort();
          throw new BankError(`mid-stream error from ${p.name}/${m.id}: ${timedOut ? 'timeout' : e.message}`);
        }
        if (chunk.done) break;
        arm();
        buf += decoder.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finished = true; break; }
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
          // Reasoning models (gpt-oss, DeepSeek-R1, Nemotron) stream their chain of
          // thought in reasoning / reasoning_content; keep it apart from the answer.
          const d = obj?.choices?.[0]?.delta;
          const thought = d && (d.reasoning_content || d.reasoning);
          if (thought) yield { reasoning: thought };
          if (d?.content) yield d.content;
          if (obj?.usage) {
            for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
              if (k in obj.usage) usage[k] = obj.usage[k];
            }
          }
        }
      }
      const cur = this.getState(p.name, stateKey);
      const meta = { ...usage };
      for (const f of ['rpm_remaining', 'rpd_remaining', 'tpm_remaining', 'tpd_remaining']) {
        if (cur[f] != null) meta[f] = cur[f];
      }
      yield { provider: p.name, model: m.id, latency_ms: Math.round(performance.now() - t0), ttfb_ms: ttfb, meta };
    } finally {
      // Also runs when the consumer stops early; drop the connection then.
      reader?.cancel().catch(() => {});
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // ---- catalog discovery (bank.py discover_live_models) ----

  /**
   * Fetch /models for every keyed provider. Listed models missing from the live
   * catalog are disabled; ids in the catalog but not listed are reported as new.
   */
  async discover(only) {
    const targets = only ? this.providers.filter((p) => only.includes(p.name)) : this.providers;
    const report = {};
    await Promise.all(targets.map(async (p) => {
      const key = this.getKey(p.name);
      if (!key) { report[p.name] = { error: `${p.key_env} not set` }; return; }
      let r;
      try {
        r = await this.fetch(`${p.base_url}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
      } catch (e) {
        report[p.name] = { error: `${e.name}: ${e.message}` };
        return;
      }
      if (!r.ok) { report[p.name] = { error: String(r.status) }; return; }
      let payload;
      try { payload = await r.json(); } catch (e) { report[p.name] = { error: `json parse: ${e.message}` }; return; }
      const data = Array.isArray(payload) ? payload : (payload?.data ?? []);
      const rawIds = new Set(data.filter((x) => x && x.id).map((x) => x.id));
      // Some providers list "models/<id>" or "<vendor>/<id>" but accept the bare suffix.
      const suffix = (id) => (id.includes('/') ? id.split('/').slice(1).join('/') : id);
      const live = new Set(rawIds);
      for (const id of rawIds) live.add(suffix(id));
      const listed = new Set(p.models.map((m) => m.id));
      const missing = [...listed].filter((id) => !live.has(id)).sort();
      const known = new Set([...listed, ...(p.retired || [])]);
      const fresh = [...rawIds].filter((id) => !known.has(id) && !known.has(suffix(id))).sort();
      for (const id of missing) this.disableModel(p.name, id, 'missing from /models on discovery');
      report[p.name] = { live: rawIds.size, missing, new: fresh };
    }));
    return report;
  }

  // ---- status snapshot for the UI ----

  status() {
    const now = this.now();
    return this.providers.map((p) => ({
      name: p.name,
      label: p.label,
      has_key: Boolean(this.getKey(p.name)),
      disabled: this.state.disabled_providers[p.name] ?? null,
      models: p.models.map((m) => {
        const s = this.getState(p.name, this._stateKey(p, m));
        return {
          id: m.id,
          tier: m.tier,
          disabled: this.modelDisabledReason(p.name, m.id),
          cooldown_remaining_s: Math.max(0, s.cooldown_until - now),
          latency_p50_ms: s.latency_p50_ms,
          rpm_remaining: s.rpm_remaining,
          rpd_remaining: s.rpd_remaining,
          rpd_limit: s.rpd_limit ?? m.doc_rpd ?? null,
          tpm_remaining: s.tpm_remaining,
        };
      }),
    }));
  }
}
