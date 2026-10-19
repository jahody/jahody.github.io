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
  {
    slug: 'llm-clustering-benchmark',
    title: 'LLM Clustering Benchmark',
    tagline: 'Do LLM-guided clustering methods beat classical baselines? A controlled, cost-aware benchmark.',
    tags: ['Python', 'LLMs', 'Clustering', 'Paper'],
    status: 'showcase',
    repo: 'https://github.com/jahody/llm-clustering-benchmark',
    summary: [
      'Five LLM-guided clustering methods (Few-Shot Clustering, LSCK-HC, k-LLMmeans, SPILL, Cequel) run head-to-head against k-means, Ward agglomerative and spectral clustering on Banking77, CLINC150 and MASSIVE, with three embedding models. All methods share one LLM and the same cached embeddings, so differences come from the method, not the encoder.',
      'Most of the reported advantage of LLM clustering comes from comparing against weak k-means. Against the best classical method, only 1 of 45 method × encoder × dataset cells wins by more than its seed variance. On strong encoders, Ward matches or beats every LLM method at zero cost, while the LLM methods cost 100–1000× more in time and money.',
    ],
    highlights: [
      'Paper: "Do LLM Clustering Methods Outperform Classical Baselines? A Controlled, Cost-Aware Benchmark", ITAT 2026.',
      'Each method\'s core loop and prompts are reimplemented from its original repo to run under the shared backbone.',
      'Every run records accuracy (ACC, NMI, ARI) and cost (tokens, USD, wall-clock time).',
      'Precomputed embeddings ship with the code, so the grid reproduces without re-embedding.',
    ],
  },
  {
    slug: 'speedcam',
    title: 'SpeedCam',
    tagline: 'Measure the speed of passing cars with a phone camera, right in the browser.',
    tags: ['JavaScript', 'TensorFlow.js', 'Computer vision', 'Device sensors'],
    status: 'live',
    demo: 'https://jahody.github.io/speedcam/',
    repo: 'https://github.com/jahody/speedcam',
    summary: [
      'Point your phone at the road. SpeedCam detects vehicles with COCO-SSD, tracks them across frames, and turns their motion into km/h. Each measurement goes into a speed log with a photo.',
      'Speed comes from the best estimator available: a tap calibration over a known distance, a size-free projection onto the road plane from the phone\'s orientation sensors and camera height, or a fallback from typical vehicle dimensions.',
    ],
    highlights: [
      'A single HTML file with no backend. Video is processed on the device, and the log stays in the browser.',
      'The camera\'s field of view self-tunes from passing cars and is remembered per device.',
      'Road name and speed limit come from GPS via OpenStreetMap (Mapy.com optional), with an alert above a set threshold.',
      'Calibration wizard: tap two points on the road and pick their distance.',
    ],
  },
];
