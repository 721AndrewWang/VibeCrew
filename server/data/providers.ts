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
    description: '深度求索，按用量计费，价格低',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash[1m]',
    fastModel: 'deepseek-flash',
    models: ['deepseek-flash[1m]', 'deepseek-v4-pro'],
    docsUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    hint: 'API Key 在 platform.deepseek.com 的「API Keys」页面创建。',
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    description: 'Kimi K3，1M 上下文，适合编程智能体',
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
    name: '智谱 GLM',
    description: 'GLM-5.3，推荐 GLM Coding Plan 套餐',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3',
    fastModel: 'glm-5.3-flash',
    models: ['glm-5.3', 'glm-5.3-flash'],
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    env: { API_TIMEOUT_MS: '3000000' },
    hint: 'API Key 在智谱开放平台（bigmodel.cn）的「API Keys」页面获取；团队套餐的 Key 和平台其他 Key 不通用。',
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    description: 'Qwen 3.7 系列，也能调用百炼上的其他模型',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    model: 'qwen3.7-plus',
    fastModel: 'qwen3.6-flash',
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3-coder-plus', 'qwen3.6-flash'],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
    hint: '这是 Token Plan 套餐的地址。按量付费的 Key 请把地址换成百炼控制台里显示的 https://<工作空间 ID>.cn-beijing.maas.aliyuncs.com/apps/anthropic。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax-M3，1M 上下文',
    baseUrl: 'https://api.minimax.cn/anthropic',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M3',
    docsUrl: 'https://platform.minimax.cn/docs/token-plan/claude-code',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    hint: '海外账号请把地址换成 https://api.minimax.io/anthropic。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '一个 Key 用几百种模型（Claude、GPT、Gemini…），需要能访问海外网络',
    baseUrl: 'https://openrouter.ai/api',
    model: '~anthropic/claude-sonnet-latest[1m]',
    fastModel: '~anthropic/claude-haiku-latest',
    models: ['~anthropic/claude-opus-latest[1m]', '~anthropic/claude-sonnet-latest[1m]', '~anthropic/claude-haiku-latest'],
    docsUrl: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    hint: '也可以填 openai/…、google/… 这样的其他模型 ID，但 Claude Code 是为 Claude 模型优化的，换成别家模型可能会有兼容问题。',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机模型）',
    description: '在自己电脑上跑开源模型，免费，需要较好的显卡',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3.5',
    fastModel: 'qwen3.5',
    defaultToken: 'ollama',
    docsUrl: 'https://docs.ollama.com/integrations/claude-code',
    hint: '需要 Ollama 0.14 或更新版本，先用 ollama pull 下载模型，再把模型名填在下面；上下文长度建议设到 64k 以上。不需要 Key。',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '任何兼容 Anthropic Messages API 的地址，比如 LiteLLM 或公司内部网关',
    baseUrl: '',
    model: '',
    fastModel: '',
  },
];

export function providerPreset(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
