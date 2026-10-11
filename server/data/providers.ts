import type { ProviderPreset } from '../../shared/types';

/**
 * Providers with an Anthropic-compatible endpoint that Claude Code can talk to, set up the way
 * each provider's own Claude Code guide recommends (checked September 2026). Model names change
 * often, so every field stays editable in Settings.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'Pay as you go, low prices',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash[1m]',
    fastModel: 'deepseek-flash',
    models: ['deepseek-flash[1m]', 'deepseek-v4-pro'],
    docsUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    hint: 'Create an API key on the "API Keys" page at platform.deepseek.com.',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot AI)',
    description: 'Kimi K3, 1M context, good for coding agents',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    model: 'kimi-k3[1m]',
    fastModel: 'kimi-k2.7-code',
    subagentsUseMain: true,
    models: ['kimi-k3[1m]', 'kimi-k2.7-code'],
    docsUrl: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
  },
  {
    id: 'glm',
    name: 'Zhipu GLM',
    description: 'GLM-5.3, the GLM Coding Plan is recommended',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    fastModel: 'glm-5.3-flash',
    models: ['glm-5.3', 'glm-5.3-flash'],
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    env: { API_TIMEOUT_MS: '3000000' },
    hint: 'Get an API key on the "API Keys" page of the Zhipu open platform (bigmodel.cn). Keys for team plans are not interchangeable with other keys on the platform.',
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba Cloud Model Studio)',
    description: 'Qwen 3.7 series, can also call other models on Model Studio',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    model: 'qwen3.7-plus',
    fastModel: 'qwen3.6-flash',
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3-coder-plus', 'qwen3.6-flash'],
    docsUrl: 'https://help.aliyun.com/en/model-studio/claude-code',
    hint: 'This is the Token Plan address. For a pay-as-you-go key, change it to the https://<workspace ID>.cn-beijing.maas.aliyuncs.com/apps/anthropic address shown in the Model Studio console.',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax-M3, 1M context',
    baseUrl: 'https://api.minimax.cn/anthropic',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M3',
    docsUrl: 'https://platform.minimax.cn/docs/token-plan/claude-code',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    hint: 'For an international account, change the address to https://api.minimax.io/anthropic.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key for hundreds of models (Claude, GPT, Gemini...), needs access to international networks',
    baseUrl: 'https://openrouter.ai/api',
    model: '~anthropic/claude-sonnet-latest[1m]',
    fastModel: '~anthropic/claude-haiku-latest',
    models: ['~anthropic/claude-opus-latest[1m]', '~anthropic/claude-sonnet-latest[1m]', '~anthropic/claude-haiku-latest'],
    docsUrl: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    hint: 'You can also enter other model IDs such as openai/... or google/..., but Claude Code is optimized for Claude models, so other models may have compatibility issues.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local models)',
    description: 'Run open-source models on your own computer, free, needs a decent GPU',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3.5',
    fastModel: 'qwen3.5',
    defaultToken: 'ollama',
    docsUrl: 'https://docs.ollama.com/integrations/claude-code',
    hint: 'Needs Ollama 0.14 or newer. Download a model with ollama pull first, then enter the model name below. A context length of 64k or more is recommended. No key needed.',
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Any address compatible with the Anthropic Messages API, such as LiteLLM or an internal company gateway',
    baseUrl: '',
    model: '',
    fastModel: '',
  },
];

export function providerPreset(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
