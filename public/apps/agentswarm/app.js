// UI for the agentSwarm web app. Adapted from agentswarm/webapp/static/app.js,
// with the /api/* calls replaced by the in-browser Bank (bank.js).

import { Bank, BankExhausted } from './bank.js';
import { PROVIDERS } from './providers.js';

const $ = (sel) => document.querySelector(sel);

// Small DOM builder; children are text or nodes, so nothing from a provider is parsed as HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const TIER_NAMES = { T1: 'reasoning', T2: 'general', T3: 'fast' };

// ---------- keys ----------
// Session storage by default; local storage only when the user ticks "remember".

const KEYS = 'agentswarm.keys.v1';
const REMEMBER = 'agentswarm.remember';

const store = (name) => { try { return window[name]; } catch { return null; } };
const sGet = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const sSet = (s, k, v) => { try { s?.setItem(k, v); } catch { /* blocked or full */ } };
const sDel = (s, k) => { try { s?.removeItem(k); } catch { /* blocked */ } };

let remember = sGet(store('localStorage'), REMEMBER) === '1';
let keys = {};
try { keys = JSON.parse(sGet(store(remember ? 'localStorage' : 'sessionStorage'), KEYS) || '{}') || {}; } catch { keys = {}; }

function persistKeys() {
  const [target, other] = remember ? ['localStorage', 'sessionStorage'] : ['sessionStorage', 'localStorage'];
  if (Object.keys(keys).length) sSet(store(target), KEYS, JSON.stringify(keys));
  else sDel(store(target), KEYS);
  sDel(store(other), KEYS);
  sSet(store('localStorage'), REMEMBER, remember ? '1' : '0');
}

const bank = new Bank({ getKey: (name) => keys[name] || '' });

function flash(text, isErr = false) {
  const msg = $('#keys-msg');
  msg.textContent = text;
  msg.className = isErr ? 'msg err' : 'msg';
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { msg.textContent = ''; }, 4000);
}

function renderKeys() {
  const list = $('#key-list');
  // Keep anything typed but not yet saved across re-renders.
  const typed = {};
  for (const input of list.querySelectorAll('input')) if (input.value) typed[input.dataset.provider] = input.value;
  list.replaceChildren();
  for (const p of PROVIDERS) {
    const tiers = {};
    for (const m of p.models) tiers[m.tier] = (tiers[m.tier] || 0) + 1;
    const saved = keys[p.name];
    const off = bank.isProviderDisabled(p.name);
    list.append(h('div', { class: 'key-row' },
      h('div', { class: 'key-label' },
        h('span', { class: `dot ${saved ? (off ? 'off' : 'on') : ''}`, title: off ? 'key rejected' : saved ? 'key saved' : 'no key' }),
        h('strong', {}, p.label),
        h('a', { href: p.key_url, target: '_blank', rel: 'noopener noreferrer' }, 'get key'),
        p.data_used_for_training && h('span', { class: 'badge train', title: 'This provider may train on free-tier prompts' }, 'trains on data'),
        h('span', { class: 'badge tiers' }, Object.keys(tiers).sort().map((t) => `${t}:${tiers[t]}`).join(' ')),
      ),
      h('div', { class: 'key-input' },
        h('input', {
          type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-provider': p.name,
          'aria-label': `${p.label} API key`,
          placeholder: saved ? `saved …${saved.slice(-4)}` : p.key_env,
          value: typed[p.name],
        }),
        saved && h('button', { title: `Remove the ${p.label} key`, onclick: () => removeKey(p.name) }, 'Clear'),
      ),
      p.note && h('p', { class: 'key-note' }, p.note),
    ));
  }
}

function saveKeys() {
  let n = 0;
  for (const input of document.querySelectorAll('#key-list input')) {
    const v = input.value.trim();
    input.value = '';
    if (!v) continue;
    keys[input.dataset.provider] = v;
    bank.enableProvider(input.dataset.provider); // a new key gets a fresh chance after a 401
    n++;
  }
  if (!n) return flash('Paste a key into a field first.', true);
  persistKeys();
  renderAll();
  flash(`Saved ${n} key${n > 1 ? 's' : ''}${remember ? ' on this device' : ' for this tab'}.`);
}

function removeKey(name) {
  delete keys[name];
  persistKeys();
  renderAll();
}

function forgetKeys() {
  keys = {};
  for (const s of ['localStorage', 'sessionStorage']) sDel(store(s), KEYS);
  renderAll();
  flash('Keys removed from this browser.');
}

// ---------- status ----------

const openProviders = new Set();

function fmtQuota(m) {
  if (m.rpd_remaining != null && m.rpd_limit != null) return `${m.rpd_remaining}/${m.rpd_limit} rpd`;
  if (m.rpd_remaining != null) return `${m.rpd_remaining} rpd left`;
  if (m.rpm_remaining != null) return `${m.rpm_remaining} rpm left`;
  if (m.rpd_limit != null) return `${m.rpd_limit} rpd`;
  return '';
}

function renderStatus() {
  const list = $('#status-list');
  list.replaceChildren();
  for (const p of bank.status()) {
    const live = p.models.filter((m) => !m.disabled).length;
    const open = openProviders.has(p.name);
    const head = h('button', {
      class: 'prov-head', 'aria-expanded': String(open),
      onclick: () => { open ? openProviders.delete(p.name) : openProviders.add(p.name); renderStatus(); },
    },
    h('span', { class: 'chev' }, open ? '▾' : '▸'),
    h('span', { class: `dot ${p.has_key ? (p.disabled ? 'off' : 'on') : ''}` }),
    h('span', {}, p.label),
    h('span', { class: 'badge' }, `${live}/${p.models.length} models`));
    const block = h('div', { class: 'prov-block' }, head);
    if (p.disabled) block.append(h('p', { class: 'prov-reason' }, `disabled: ${p.disabled}. Save a new key to retry.`));
    if (open) {
      block.append(h('table', { class: 'model-table' }, h('tbody', {}, p.models.map((m) => h('tr', {},
        h('td', { title: m.id }, m.id),
        h('td', {}, m.tier),
        h('td', {}, m.latency_p50_ms != null ? `${Math.round(m.latency_p50_ms)}ms` : ''),
        h('td', {},
          m.disabled ? h('span', { class: 'dis', title: m.disabled }, 'disabled')
            : m.cooldown_remaining_s > 0 ? h('span', { class: 'cool' }, `cooldown ${Math.ceil(m.cooldown_remaining_s)}s`)
              : fmtQuota(m)),
      )))));
    }
    list.append(block);
  }
}

async function runDiscover() {
  const btn = $('#discover');
  const out = $('#discover-report');
  if (!Object.keys(keys).length) { out.textContent = 'Add a key first.'; return; }
  btn.disabled = true;
  btn.textContent = 'Discovering…';
  try {
    const report = await bank.discover(Object.keys(keys));
    out.replaceChildren(...Object.entries(report).map(([name, r]) => {
      const label = bank.provider(name)?.label || name;
      if (r.error) return h('div', {}, `${label}: error ${r.error}`);
      const parts = [`${r.live} live`];
      if (r.missing.length) parts.push(`disabled ${r.missing.join(', ')}`);
      if (r.new.length) parts.push(`${r.new.length} not in this app's list`);
      return h('div', { title: r.new.join('\n') }, `${label}: ${parts.join(' · ')}`);
    }));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Discover models';
    renderAll();
  }
}

function resetState() {
  bank.resetState();
  $('#discover-report').textContent = '';
  renderAll();
}

// ---------- chat ----------

const messagesEl = $('#messages');
const history = []; // {role, content}; the system prompt is prepended at send time
let chatCtrl = null;

function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function addBubble(cls, text) {
  const el = h('div', { class: `bubble ${cls}` }, text);
  messagesEl.append(el);
  scrollDown();
  return el;
}

// A streamed reply: the answer, plus a collapsed "Thinking" block when the model
// streams its chain of thought separately (gpt-oss, DeepSeek-R1, Nemotron).
function replyView(cls) {
  const answerEl = h('div', { class: 'answer cursor' });
  const thinkBody = h('div', { class: 'thinking-body' });
  const thinking = h('details', { class: 'thinking', hidden: true }, h('summary', {}, 'Thinking'), thinkBody);
  const el = h('div', { class: cls }, thinking, answerEl);
  let answer = '';
  let thought = '';
  return {
    el,
    get answer() { return answer; },
    get thought() { return thought; },
    push(v) {
      if (typeof v === 'string') {
        answer += v;
        answerEl.textContent = answer;
      } else {
        thought += v.reasoning;
        thinking.hidden = false;
        thinkBody.textContent = thought;
      }
    },
    fail(message) {
      el.classList.add('error');
      answerEl.textContent = message;
    },
    finish(outcome) {
      answerEl.classList.remove('cursor');
      if (answer || el.classList.contains('error')) return;
      answerEl.classList.add('note');
      if (thought && outcome === 'done') answerEl.textContent = 'No answer: the model was still thinking when it reached Max tokens.';
      else if (outcome === 'done') answerEl.textContent = '(empty reply)';
    },
  };
}

function metaText(info) {
  const parts = [bank.provider(info.provider)?.label || info.provider, info.model, `${info.latency_ms} ms`];
  if (info.ttfb_ms != null) parts.push(`first byte ${info.ttfb_ms} ms`);
  if (info.meta?.total_tokens != null) parts.push(`${info.meta.total_tokens} tok`);
  if (info.meta?.attempts > 1) parts.push(`attempt ${info.meta.attempts}`);
  return parts.join(' · ');
}

function friendlyError(err, tier) {
  if (err instanceof BankExhausted) {
    return Object.keys(keys).length
      ? `No ${tier} model is available right now: every candidate is cooling down or disabled. Try another tier, wait a minute, or add another provider's key.\n\n${err.message}`
      : 'Add at least one API key in the sidebar first.';
  }
  return String(err?.message || err);
}

async function sendMessage(text) {
  messagesEl.querySelector('.empty-state')?.remove();
  history.push({ role: 'user', content: text });
  addBubble('user', text);

  const system = $('#system-prompt').value.trim();
  const tier = $('#tier').value;
  const messages = system ? [{ role: 'system', content: system }, ...history] : [...history];
  const maxTokens = Math.min(8192, parseInt($('#max-tokens').value, 10) || 1024);

  const reply = replyView('bubble assistant');
  messagesEl.append(reply.el);
  scrollDown();
  const send = $('#send');
  chatCtrl = new AbortController();
  send.textContent = 'Stop';
  let outcome = 'done';

  try {
    for await (const v of bank.stream(messages, { tier, maxTokens, signal: chatCtrl.signal })) {
      if (typeof v === 'string' || 'reasoning' in v) {
        reply.push(v);
      } else {
        messagesEl.append(h('div', { class: 'meta-line' }, metaText(v)));
      }
      scrollDown();
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      outcome = 'stopped';
      if (reply.answer || reply.thought) messagesEl.append(h('div', { class: 'meta-line' }, 'stopped'));
    } else {
      outcome = 'error';
      addBubble('error', friendlyError(err, tier));
    }
  } finally {
    reply.finish(outcome);
    // Only the answer goes back into the conversation, never the reasoning.
    if (reply.answer) history.push({ role: 'assistant', content: reply.answer });
    else if (!reply.thought) reply.el.remove();
    chatCtrl = null;
    send.textContent = 'Send';
    renderAll();
    $('#prompt').focus();
  }
}

// ---------- compare ----------

const MAX_PICKS = 6;
const picks = new Set(); // "provider|model"
let compareCtrl = null;

function eligibility(p, m) {
  if (!keys[p.name]) return { ok: false, why: 'no key' };
  if (bank.isProviderDisabled(p.name)) return { ok: false, why: 'key rejected' };
  const reason = bank.modelDisabledReason(p.name, m.id);
  if (reason) return { ok: false, why: `disabled: ${reason}` };
  const s = bank.getState(p.name, p.shared_bucket ? '*' : m.id);
  const cool = s.cooldown_until - Date.now() / 1000;
  if (cool > 0) return { ok: true, grey: true, why: `cooling down ${Math.ceil(cool)}s` };
  return { ok: true };
}

function renderPicker() {
  const box = $('#model-picker');
  box.replaceChildren();
  // Drop picks that became ineligible (key removed, model disabled).
  for (const id of [...picks]) {
    const [pn, mid] = id.split('|');
    const p = bank.provider(pn);
    const m = p?.models.find((x) => x.id === mid);
    if (!m || !eligibility(p, m).ok) picks.delete(id);
  }
  const full = picks.size >= MAX_PICKS;
  for (const p of PROVIDERS) {
    const group = h('div', { class: 'pick-group' }, h('h3', {}, p.label));
    if (!keys[p.name]) {
      group.append(h('div', { class: 'none' }, 'add a key to use'));
    } else {
      for (const m of p.models) {
        const id = `${p.name}|${m.id}`;
        const e = eligibility(p, m);
        const checked = picks.has(id);
        group.append(h('label', { class: `pick ${!e.ok || e.grey ? 'grey' : ''}`, title: e.why ? `${m.id}: ${e.why}` : m.id },
          h('input', {
            type: 'checkbox', checked, disabled: !e.ok || (full && !checked),
            onchange: (ev) => { ev.target.checked ? picks.add(id) : picks.delete(id); renderPicker(); },
          }),
          h('span', { class: 'id' }, m.id),
          h('span', { class: 't' }, m.tier),
        ));
      }
    }
    box.append(group);
  }
  $('#pick-count').textContent = `${picks.size}/${MAX_PICKS}`;
}

// Quick-select: up to 6 eligible models of a tier, taking one per provider in turn.
function quickPick(tier) {
  picks.clear();
  if (tier !== 'none') {
    const queues = PROVIDERS.map((p) => p.models
      .filter((m) => m.tier === tier && eligibility(p, m).ok && !eligibility(p, m).grey)
      .map((m) => `${p.name}|${m.id}`));
    while (picks.size < MAX_PICKS && queues.some((q) => q.length)) {
      for (const q of queues) if (q.length && picks.size < MAX_PICKS) picks.add(q.shift());
    }
  }
  renderPicker();
}

async function runCompare() {
  const prompt = $('#compare-prompt').value.trim();
  const results = $('#compare-results');
  if (!prompt) return $('#compare-prompt').focus();
  if (!picks.size) {
    results.replaceChildren(h('p', { class: 'hint' }, Object.keys(keys).length ? 'Pick at least one model above.' : 'Add an API key in the sidebar, then pick models.'));
    return;
  }
  const maxTokens = Math.min(8192, parseInt($('#compare-max-tokens').value, 10) || 512);
  const messages = [{ role: 'user', content: prompt }];
  compareCtrl = new AbortController();
  const run = $('#compare-run');
  run.textContent = 'Stop';

  const jobs = [...picks].map((id) => {
    const [pn, mid] = id.split('|');
    const p = bank.provider(pn);
    const tier = p.models.find((m) => m.id === mid)?.tier;
    const reply = replyView('body');
    const foot = h('footer', {});
    const card = h('article', { class: 'card' },
      h('header', {}, h('span', { class: 'who' }, p.label), h('span', { class: 'id', title: mid }, mid), h('span', { class: 'badge' }, tier)),
      reply.el, foot);
    return { pn, mid, reply, foot, card };
  });
  results.replaceChildren(...jobs.map((j) => j.card));

  await Promise.all(jobs.map(async ({ pn, mid, reply, foot }) => {
    let outcome = 'done';
    try {
      for await (const v of bank.streamModel(pn, mid, messages, { maxTokens, signal: compareCtrl.signal })) {
        if (typeof v === 'string' || 'reasoning' in v) {
          reply.push(v);
        } else {
          const parts = [`first byte ${v.ttfb_ms} ms`, `total ${(v.latency_ms / 1000).toFixed(1)} s`];
          if (v.meta?.total_tokens != null) parts.push(`${v.meta.total_tokens} tok`);
          foot.textContent = parts.join(' · ');
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        outcome = 'stopped';
        foot.textContent = 'stopped';
      } else if (!reply.answer && !reply.thought) {
        outcome = 'error';
        reply.fail(String(err?.message || err));
      } else {
        outcome = 'error';
        foot.textContent = `cut off: ${err?.message || err}`;
      }
    } finally {
      reply.finish(outcome);
    }
  }));

  compareCtrl = null;
  run.textContent = 'Run';
  renderAll();
}

// ---------- tabs, sidebar, wiring ----------

function selectTab(name) {
  for (const t of ['chat', 'compare']) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`#panel-${t}`).hidden = t !== name;
  }
  if (name === 'compare') renderPicker();
}

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
}

function renderAll() {
  renderKeys();
  renderStatus();
  if (!$('#panel-compare').hidden) renderPicker();
}

$('#tab-chat').addEventListener('click', () => selectTab('chat'));
$('#tab-compare').addEventListener('click', () => selectTab('compare'));
$('#toggle-sidebar').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));

$('#remember').checked = remember;
$('#remember').addEventListener('change', (e) => {
  remember = e.target.checked;
  persistKeys();
  flash(remember ? 'Keys will be kept on this device.' : 'Keys will be forgotten when this tab closes.');
});
$('#save-keys').addEventListener('click', saveKeys);
$('#forget-keys').addEventListener('click', forgetKeys);
$('#key-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) saveKeys(); });
$('#refresh-status').addEventListener('click', renderStatus);
$('#discover').addEventListener('click', runDiscover);
$('#reset-state').addEventListener('click', resetState);

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chatCtrl) return chatCtrl.abort();
  const ta = $('#prompt');
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  sendMessage(text);
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!chatCtrl) $('#composer').requestSubmit();
  }
});
$('#clear-chat').addEventListener('click', () => {
  chatCtrl?.abort();
  history.length = 0;
  messagesEl.replaceChildren();
});

for (const b of document.querySelectorAll('[data-quick]')) b.addEventListener('click', () => quickPick(b.dataset.quick));
$('#compare-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (compareCtrl) return compareCtrl.abort();
  runCompare();
});

// Cooldowns count down; refresh the panels while the tab is visible,
// skipping any panel that has keyboard focus so it isn't rebuilt under the user.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const focused = (sel) => $(sel).contains(document.activeElement);
  if (!focused('#status-list')) renderStatus();
  if (!$('#panel-compare').hidden && !focused('#model-picker')) renderPicker();
}, 5000);

renderAll();
if (!Object.keys(keys).length) setSidebar(true);
