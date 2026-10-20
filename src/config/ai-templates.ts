import type { AiModelType } from '@shared/types'

/**
 * 内置 AI 供应商预设模板（单一数据源）
 *
 * 任何需要展示 / 使用预设模板的地方，都应从此文件导入 {@link AI_TEMPLATES}，
 * 避免在组件内重复维护模板列表。
 *
 * 当前消费方：
 *   - src/components/SetupWizard.vue（首次引导向导）
 *   - src/components/Settings/AiSettings.vue（AI 设置页添加模板）
 *
 * 更新模板时只需修改本文件，两处 UI 都会同步。
 */

/**
 * 低于这个上下文窗口就在配置时提醒一次（见 AISERVICE_SPEC「上下文窗口偏小的模型」）。
 *
 * 当代主流模型基本从这里起步，拿窗口大小粗略判断「这模型能不能干多步任务」够用。
 * 只提醒、不禁止：本地离线、断网、省钱都是真实需求，用户有权自己权衡。
 */
export const RECOMMENDED_MIN_CONTEXT = 128_000

export interface AiTemplate {
  /** 模板名称（用于展示 & 作为 profile name） */
  name: string
  /** Chat Completions 兼容端点（Anthropic 原生除外） */
  apiUrl: string
  /** 默认 model ID */
  model: string
  /** 描述文案的 i18n key */
  descKey: string
  /** 申请/管理 API Key 的页面链接（空字符串表示无） */
  keyUrl: string
  /** 默认上下文长度（tokens） */
  contextLength: number
  /** 是否是本地部署（不需要 API Key 且不需要联网） */
  isLocal: boolean
  /** 是否需要 API Key */
  needsApiKey: boolean
  /** 预设时标成视觉模型，用户不必再关联另一个 */
  modelType?: AiModelType
}

export const AI_TEMPLATES: AiTemplate[] = [
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    descKey: 'aiSettings.templates.deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
    modelType: 'vision',
  },
  {
    name: 'Qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.7-plus',
    descKey: 'aiSettings.templates.qwen',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Doubao',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'doubao-seed-2-1-pro-260628',
    descKey: 'aiSettings.templates.doubao',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    contextLength: 256_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Zhipu',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-5.3-flash',
    descKey: 'aiSettings.templates.zhipu',
    keyUrl: 'https://open.bigmodel.cn/apikey/platform',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
    modelType: 'vision',
  },
  {
    name: 'Kimi',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k3',
    descKey: 'aiSettings.templates.kimi',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'MiniMax',
    apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
    model: 'MiniMax-M3',
    descKey: 'aiSettings.templates.minimax',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.6',
    descKey: 'aiSettings.templates.openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    contextLength: 1_050_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Claude',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-5',
    descKey: 'aiSettings.templates.claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Gemini',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-3.8-flash',
    descKey: 'aiSettings.templates.gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Grok',
    apiUrl: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-4.6',
    descKey: 'aiSettings.templates.grok',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    contextLength: 500_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Mistral',
    apiUrl: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-large-2512',
    descKey: 'aiSettings.templates.mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    contextLength: 256_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen3.5:9b',
    descKey: 'aiSettings.templates.ollama',
    keyUrl: 'https://ollama.com/',
    contextLength: 256_000,
    isLocal: true,
    needsApiKey: false,
  },
]
