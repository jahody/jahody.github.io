export interface Project {
  slug: string;
  title: string;
  tagline: string;
  tags: string[];
  status: 'live' | 'showcase';
  demo?: string;
  repo?: string;
  summary: string[];
  highlights: string[];
}

export const projects: Project[] = [
  {
    slug: 'cyclesync',
    title: 'CycleSync',
    tagline: 'Menstrual cycle phases projected into Google Calendar, with one-tap recalibration.',
    tags: ['PWA', 'JavaScript', 'Google Calendar API', 'OAuth'],
    status: 'live',
    demo: '/apps/cycle/',
    summary: [
      'CycleSync projects a 28-day, four-phase cycle a full year ahead (about 14 cycles, 56 events) into a dedicated secondary Google Calendar, so your primary calendar stays clean.',
      'When a period starts earlier or later than predicted, pick the actual start date. Future events are removed and regenerated in one step.',
    ],
    highlights: [
      'Runs entirely in the browser. You sign in with your own Google account, and no data touches a server of mine.',
      'Installable as a PWA on iOS and Android for one-tap logging.',
      'Also ships as a Google Apps Script web app for a two-minute setup.',
      'Core phase engine is a small pure module with unit tests.',
    ],
  },
  {
    slug: 'surveymaster',
    title: 'SurveyMaster',
    tagline: 'Classify research papers against hierarchical taxonomies using multi-LLM consensus voting.',
    tags: ['Python', 'LLMs', 'Taxonomies', 'Evaluation'],
    status: 'showcase',
    summary: [
      'Different LLMs have complementary organizational intuitions. SurveyMaster aggregates their confidence-weighted votes to classify papers more reliably than any single model.',
      'An iterative refinement loop measures taxonomy coverage and re-prompts the LLM to fix dead and overloaded leaves.',
    ],
    highlights: [
      'Five-stage pipeline: fetch, taxonomize, classify, evaluate, evolve (paper influence tree).',
      'Human-in-the-loop review of proposed taxonomy axes and generated taxonomies.',
      'Eight consistency and quality metrics, plus ground-truth evaluation: top-1 accuracy, top-k recall, ECE, Brier score, significance of consensus voting.',
      'Parallel async classification across papers, taxonomies, and models.',
    ],
  },
  {
    slug: 'agentswarm',
    title: 'agentSwarm',
    tagline: 'A pool of free-tier LLM providers, routed by capability tier and remaining quota.',
    tags: ['Python', 'LLM routing', 'MCP', 'SQLite'],
    status: 'showcase',
    summary: [
      'agentSwarm is a local-first, OpenAI-compatible router over 7 free-tier providers and 40+ models. It picks a model by capability tier and quota, and fails over automatically when one is exhausted.',
      'It also runs as an MCP server, so Claude Code can delegate cheap subtasks to free models.',
    ],
    highlights: [
      'Tiers: T1 reasoning-first, T2 general and quota-first, T3 fast (latency p50).',
      'Quota-aware routing, cooldowns, and automatic model catalog discovery that disables stale IDs.',
      'Streaming support, header-based quota tracking, and persisted state in SQLite.',
      'Test suite covers failover, streaming, scoring, normalization, and MCP passthrough.',
    ],
  },
];
