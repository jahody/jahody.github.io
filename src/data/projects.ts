export interface Project {
  slug: string;
  title: string;
  tagline: string;
  /** Short label shown above the project's figure, e.g. 'LLM routing'. */
  category: string;
  /** Two micro-labels printed in the figure frame's bottom corners. */
  stats: [string, string];
  tags: string[];
  status: 'live' | 'showcase';
  demo?: string;
  repo?: string;
  /** Set when the work was published as a paper: shown as a badge and cited on the project page. */
  paper?: { title: string; venue: string };
  summary: string[];
  highlights: string[];
}

export const projects: Project[] = [
  {
    slug: 'llm-clustering-benchmark',
    title: 'LLM Clustering Benchmark',
    tagline: 'Do LLM clustering methods beat classical baselines?',
    category: 'Benchmark',
    stats: ['CELLS 45', 'SIG. WINS 1'],
    tags: ['Python', 'LLMs', 'Clustering', 'Paper'],
    status: 'showcase',
    repo: 'https://github.com/jahody/llm-clustering-benchmark',
    paper: {
      title: 'Do LLM Clustering Methods Outperform Classical Baselines? A Controlled, Cost-Aware Benchmark',
      venue: 'ITAT 2026',
    },
    summary: [
      'Five LLM-guided methods against k-means, Ward and spectral clustering on Banking77, CLINC150 and MASSIVE, with one shared LLM and cached embeddings. Against the best classical baseline, only 1 of 45 cells wins beyond seed variance, at 100–1000× the cost.',
    ],
    highlights: [
      'Methods reimplemented from their original repos on a shared backbone.',
      'Tracks accuracy (ACC, NMI, ARI) and cost (tokens, USD, time).',
      'Ships precomputed embeddings for exact reproduction.',
    ],
  },
  {
    slug: 'cyclesync',
    title: 'CycleSync',
    tagline: 'Menstrual cycle phases, projected into Google Calendar.',
    category: 'Calendar PWA',
    stats: ['CYCLE 28 D', 'EVENTS 56'],
    tags: ['PWA', 'JavaScript', 'Google Calendar API', 'OAuth'],
    status: 'live',
    demo: '/apps/cycle/',
    summary: [
      'Projects a 28-day, four-phase cycle a year ahead into a separate Google Calendar. When a period starts early or late, one tap regenerates the future events.',
    ],
    highlights: [
      'Runs in the browser; no data touches a server of mine.',
      'Installable as a PWA on iOS and Android.',
      'Also available as a Google Apps Script web app.',
    ],
  },
  {
    slug: 'surveymaster',
    title: 'SurveyMaster',
    tagline: 'Classifying papers by multi-LLM consensus voting.',
    category: 'Classification',
    stats: ['STAGES 5', 'METRICS 8'],
    tags: ['Python', 'TypeScript', 'LLMs', 'Taxonomies'],
    status: 'live',
    demo: '/surveymaster/',
    summary: [
      'Several LLMs vote, weighted by confidence, to place papers in hierarchical taxonomies more reliably than any single model. A refinement loop fixes dead and overloaded leaves. The whole pipeline also runs in the browser: open a finished run, or bring an OpenRouter key and start your own.',
    ],
    highlights: [
      'Five stages: fetch, taxonomize, classify, evaluate, evolve.',
      'Human review of proposed taxonomies.',
      'The browser version reproduces the Python consensus and metrics exactly.',
    ],
  },
  {
    slug: 'agentswarm',
    title: 'agentSwarm',
    tagline: 'Free-tier LLMs, routed by tier and remaining quota.',
    category: 'LLM routing',
    stats: ['PROVIDERS 7', 'MODELS 40+'],
    tags: ['Python', 'JavaScript', 'LLM routing', 'MCP'],
    status: 'live',
    demo: '/apps/agentswarm/',
    summary: [
      'An OpenAI-compatible router over 7 free-tier providers and 40+ models. It picks by capability tier and quota, fails over when one runs out, and runs as an MCP server for Claude Code. A browser version covers the 5 providers that accept calls from a web page.',
    ],
    highlights: [
      'Three tiers: reasoning, general, fast.',
      'Quota tracking, cooldowns and automatic model discovery.',
      'In the browser: bring your own keys, then chat or compare models side by side.',
    ],
  },
  {
    slug: 'speedcam',
    title: 'SpeedCam',
    tagline: 'Car speed from a phone camera, in the browser.',
    category: 'Computer vision',
    stats: ['COCO-SSD', 'ON-DEVICE'],
    tags: ['JavaScript', 'TensorFlow.js', 'Computer vision', 'Device sensors'],
    status: 'live',
    demo: 'https://jahody.github.io/speedcam/',
    repo: 'https://github.com/jahody/speedcam',
    summary: [
      'Detects cars with COCO-SSD, tracks them across frames and turns their motion into km/h, saving each reading with a photo. Speed comes from a tap calibration, the phone\'s orientation sensors, or typical vehicle sizes.',
    ],
    highlights: [
      'One HTML file; video never leaves the device.',
      'Road name and speed limit from OpenStreetMap.',
      'Field of view self-tunes from passing cars.',
    ],
  },
];
