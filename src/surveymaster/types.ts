// Data shapes for the in-browser SurveyMaster. They mirror the JSON files the Python pipeline
// (survey6-classification) writes under papers/{topic}/, collected into one Project object.

export interface Paper {
  /** arXiv ID when known (e.g. "2302.07863"), otherwise an OpenAlex work ID. */
  id: string;
  title: string;
  /** Text the models read: title, metadata and abstract, as in papers/{topic}/abstracts/*.md. */
  content: string;
  year?: number;
  month?: number;
  authors?: string;
  url?: string;
}

/** A taxonomy node, recursive. Leaves have no `items`. */
export interface TaxNode {
  chapter?: string;
  name: string;
  description?: string;
  phrases?: string[];
  hard_negative?: string;
  items?: TaxNode[];
}

/** One taxonomy file: `name` is the file stem / perspective, `items` the file contents. */
export interface Taxonomy {
  name: string;
  description: string;
  items: TaxNode[];
}

/** A taxonomy proposed by one model in stage 2, before the refiner merges them. */
export interface Proposal {
  model: string;
  perspective: string;
  description: string;
  categories: TaxNode[];
}

export interface Axis {
  perspective: string;
  description: string;
  proposals: number;
  selected: boolean;
  comment: string;
}

export interface ChapterVote {
  chapter: string;
  confidence: number;
  reason?: string;
}

export interface TaxResult {
  chapters?: ChapterVote[];
  chapter?: string | string[];
  confidence?: number;
  error?: string;
}

/** One model's results: paper id → taxonomy name → result. */
export type ModelResults = Record<string, Record<string, TaxResult>>;

export interface ConsensusEntry {
  chapter: string;
  score: number;
  /** [chapter, summed confidence], highest first. Kept as pairs so chapter keys like "3" keep their order. */
  votes: [string, number][];
  reason: string;
}

/** paper id → taxonomy name → consensus. */
export type Consensus = Record<string, Record<string, ConsensusEntry>>;

export interface EvolutionEdge {
  source: string;
  target: string;
  type: 'direct_extension' | 'conceptual_influence' | 'shared_benchmark' | 'challenges' | string;
  label?: string;
}

export interface EvolutionTree {
  metadata: { query: string; generated_at: string; total_papers: number; total_edges: number };
  nodes: { arxiv: string; name: string; time_period: string; year: number | null; month: number | null }[];
  edges: EvolutionEdge[];
  time_periods: { id: string; label: string }[];
}

export interface Settings {
  models: string[];
  refiner: string;
  topK: number;
  includeHardNegative: boolean;
  concurrency: number;
  classifyTemperature: number;
  classifyMaxTokens: number;
  seed: number;
  generationTemperature: number;
  generationMaxTokens: number;
  refinerTemperature: number;
  evolutionTemperature: number;
  evolutionMaxTokens: number;
  chunkSize: number;
  chunkOverlap: number;
  contentChars: number;
}

export interface Usage {
  prompt: number;
  completion: number;
  cost: number;
  calls: number;
}

export interface Project {
  version: 1;
  id: string;
  topic: string;
  source: 'openalex' | 'upload' | 'demo';
  createdAt: string;
  papers: Paper[];
  settings: Settings;
  proposals: Proposal[];
  axes: Axis[];
  taxonomies: Taxonomy[];
  /** model id → results */
  results: Record<string, ModelResults>;
  consensus: Consensus;
  evolution?: EvolutionTree;
  usage: Usage;
}

// Defaults follow survey6-classification/config.yaml, except the models: free models from three
// different families that accept JSON output (OpenRouter's free lineup as of October 2026; it changes,
// and the app flags selected models that have disappeared).
export const DEFAULT_SETTINGS: Settings = {
  models: [
    'nvidia/nemotron-3-super-120b-a12b:free',
    'google/gemma-4-31b-it:free',
    'minimax/minimax-m3.1-flash:free',
  ],
  refiner: 'nvidia/nemotron-3-super-120b-a12b:free',
  topK: 3,
  includeHardNegative: true,
  concurrency: 3,
  classifyTemperature: 0,
  classifyMaxTokens: 4096,
  seed: 42,
  generationTemperature: 0.5,
  generationMaxTokens: 16384,
  refinerTemperature: 0,
  evolutionTemperature: 0.3,
  evolutionMaxTokens: 8192,
  chunkSize: 20,
  chunkOverlap: 5,
  contentChars: 1200,
};

export function newProject(topic: string, source: Project['source'], papers: Paper[] = []): Project {
  return {
    version: 1,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    topic,
    source,
    createdAt: new Date().toISOString(),
    papers,
    settings: { ...DEFAULT_SETTINGS, models: [...DEFAULT_SETTINGS.models] },
    proposals: [],
    axes: [],
    taxonomies: [],
    results: {},
    consensus: {},
    usage: { prompt: 0, completion: 0, cost: 0, calls: 0 },
  };
}

/** The "filename" the Python pipeline uses for a paper in prompts and result files. */
export const paperFilename = (p: Paper | string) => `${typeof p === 'string' ? p : p.id}.md`;
