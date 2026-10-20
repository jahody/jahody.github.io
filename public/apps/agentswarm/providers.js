// Browser-side provider registry for the agentSwarm web app.
//
// Mirrors agentswarm/scripts/providers.yaml (the source of truth) and
// TIER_PRIORITY in agentswarm/bank.py. Only the providers whose APIs send
// CORS headers are listed: SambaNova and NVIDIA NIM block browser calls, so
// they stay in the Python router only.
//
// In sync with the yaml's 2026-10-20 catalog refresh (ids probed against each
// provider's live /models). Tiers for ids added then are provisional there too.
//
// T1 = reasoning/quality-first, T2 = general/quota-first, T3 = fast (latency p50).

export const PROVIDERS = [
  {
    name: 'cerebras',
    label: 'Cerebras',
    base_url: 'https://api.cerebras.ai/v1',
    key_env: 'CEREBRAS_KEY',
    key_url: 'https://cloud.cerebras.ai/',
    request_timeout: 30,
    shared_bucket: false,
    data_used_for_training: false,
    note: 'Answered 402 (billing required) in a 2026-10-19 check; may need billing set up.',
    models: [
      { id: 'gpt-oss-120b', tier: 'T1', strengths: ['general', 'reasoning'] },
      { id: 'qwen-3.8-27b', tier: 'T3', strengths: ['fast', 'general'] },
    ],
    retired: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7', 'llama-3.3-70b', 'qwen-3-32b', 'deepseek-r1-distill-llama-70b'],
  },
  {
    name: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    key_env: 'GROQ_KEY',
    key_url: 'https://console.groq.com/keys',
    request_timeout: 30,
    shared_bucket: false,
    data_used_for_training: false,
    models: [
      { id: 'openai/gpt-oss-120b', tier: 'T1', strengths: ['general', 'reasoning'] },
      { id: 'openai/gpt-oss-20b', tier: 'T2', strengths: ['general'] },
      { id: 'qwen/qwen3.8-27b', tier: 'T3', strengths: ['fast', 'multilingual'] },
    ],
    retired: [
      'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct',
      'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b', 'moonshotai/kimi-k2-instruct',
    ],
  },
  {
    name: 'google_ai_studio',
    label: 'Google AI Studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key_env: 'GOOGLE_AI_STUDIO_KEY',
    key_url: 'https://aistudio.google.com/apikey',
    request_timeout: 30,
    shared_bucket: false,
    data_used_for_training: true,
    models: [
      { id: 'gemini-2.5-flash', tier: 'T2', doc_rpm: 10, doc_rpd: 250, doc_tpm: 1000000, strengths: ['general', 'multilingual'] },
      { id: 'gemini-2.5-flash-lite', tier: 'T3', doc_rpm: 30, doc_rpd: 14000, doc_tpm: 1000000, strengths: ['fast', 'multilingual'] },
      { id: 'gemini-3.5-flash', tier: 'T1', strengths: ['reasoning', 'general'] },
      { id: 'gemini-3.5-flash-lite', tier: 'T3', strengths: ['fast', 'multilingual'] },
    ],
    retired: ['gemini-2.5-pro'],
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    key_env: 'OPENROUTER_KEY',
    key_url: 'https://openrouter.ai/settings/keys',
    note: 'Enable "free models" at openrouter.ai/settings/privacy for :free models.',
    request_timeout: 60,
    // Account-wide 20 RPM / 50 RPD across all :free models.
    shared_bucket: true,
    data_used_for_training: true,
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', tier: 'T1', doc_rpm: 20, doc_rpd: 50, strengths: ['reasoning', 'general'] },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', tier: 'T1', doc_rpm: 20, doc_rpd: 50, strengths: ['reasoning'] },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', tier: 'T1', doc_rpm: 20, doc_rpd: 50, strengths: ['reasoning', 'fast'] },
      { id: 'minimax/minimax-m3.1-flash:free', tier: 'T2', doc_rpm: 20, doc_rpd: 50, strengths: ['general'] },
      { id: 'google/gemma-4-31b-it:free', tier: 'T2', doc_rpm: 20, doc_rpd: 50, strengths: ['general', 'multilingual'] },
    ],
    retired: [
      'openai/gpt-oss-120b:free', 'z-ai/glm-4.5-air:free', 'openai/gpt-oss-20b:free', 'minimax/minimax-m2.5:free',
      'deepseek/deepseek-r1:free', 'deepseek/deepseek-r1-0528:free', 'google/gemini-2.5-pro-exp:free',
      'qwen/qwen-2.5-72b-instruct:free', 'mistralai/mistral-small-3.1-24b-instruct:free',
      'nousresearch/hermes-3-llama-3.1-405b:free', 'qwen/qwen3-next-80b-a3b-instruct:free', 'qwen/qwen3-coder:free',
      'meta-llama/llama-3.3-70b-instruct:free', 'meta-llama/llama-3.2-3b-instruct:free', 'google/gemma-3-12b-it:free',
    ],
  },
  {
    name: 'huggingface',
    label: 'HuggingFace',
    base_url: 'https://router.huggingface.co/v1',
    key_env: 'HF_TOKEN',
    key_url: 'https://huggingface.co/settings/tokens',
    note: 'A token with Read scope is enough. Free use is a small monthly credit; after that it answers 402.',
    request_timeout: 60,
    shared_bucket: false,
    data_used_for_training: false,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', tier: 'T2', doc_rpm: 500000, doc_tpm: 300000, strengths: ['general', 'multilingual'] },
      { id: 'deepseek-ai/DeepSeek-R1', tier: 'T1', doc_rpm: 500000, doc_tpm: 300000, strengths: ['reasoning', 'coding'] },
      { id: 'deepseek-ai/DeepSeek-V3.2', tier: 'T1', doc_rpm: 500000, doc_tpm: 300000, strengths: ['coding', 'general'] },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'T1', doc_rpm: 500000, doc_tpm: 300000, strengths: ['general', 'multilingual'] },
      { id: 'Qwen/Qwen3-Next-80B-A3B-Instruct', tier: 'T2', doc_rpm: 500000, doc_tpm: 300000, strengths: ['general', 'multilingual'] },
      { id: 'google/gemma-3-27b-it', tier: 'T3', doc_rpm: 500000, doc_tpm: 300000, strengths: ['fast', 'multilingual'] },
    ],
    retired: ['Qwen/Qwen3-Coder-480B-A35B-Instruct'],
  },
];

// Provider preference per tier (bank.py TIER_PRIORITY minus sambanova/nvidia_nim;
// groq and google_ai_studio appended to T1, which now has models from both).
// T3 ignores this and ranks by measured latency instead.
export const TIER_PRIORITY = {
  T1: ['huggingface', 'cerebras', 'openrouter', 'groq', 'google_ai_studio'],
  T2: ['groq', 'huggingface', 'google_ai_studio', 'openrouter'],
  T3: ['groq', 'cerebras', 'google_ai_studio', 'huggingface', 'openrouter'],
};
