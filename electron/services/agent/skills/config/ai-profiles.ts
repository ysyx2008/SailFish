/**
 * AI 模型配置：列表展示 + 一条一条增删改（禁止整表覆盖）
 */

import { v4 as uuidv4 } from 'uuid'
import type { AiProfile, AiModelType, ApiFormat } from '@shared/types'
import type { ToolResult } from '../../tools/types'

export interface AiProfileStore {
  getAiProfiles(): AiProfile[]
  addAiProfile(profile: AiProfile): void
  updateAiProfile(profile: AiProfile): void
  deleteAiProfile(id: string): void
  getActiveAiProfile(): string
  setActiveAiProfile(id: string): void
  setAiProfiles(profiles: AiProfile[]): void
}

export type AiProfileTestFn = (
  profile: Partial<AiProfile>
) => Promise<{ success: boolean; message: string; latencyMs?: number }>

const MODEL_TYPES = new Set<AiModelType>(['general', 'vision'])
const API_FORMATS = new Set<ApiFormat>(['auto', 'openai', 'anthropic'])

function redactKey(hasKey: boolean): string {
  return hasKey ? 'Key 已配置' : 'Key 未配置'
}

function profileLine(p: AiProfile, activeId: string): string {
  const flags = [redactKey(!!p.apiKey)]
  if (p.id === activeId) flags.push('当前默认')
  if (p.modelType && p.modelType !== 'general') flags.push(p.modelType)
  if (p.oemCatalogId) flags.push('公司提供，不能改')
  return `    - **${p.name}** \`${p.id}\` · ${p.model || '_(无模型名)_'} · \`${p.apiUrl || '_(无地址)_'}\` · ${flags.join(' · ')}`
}

export function formatAiProfilesSummary(store: AiProfileStore): string {
  const profiles = store.getAiProfiles()
  const activeId = store.getActiveAiProfile()
  if (profiles.length === 0) {
    return '  - **AI 模型配置** — _(未配置)_  使用 `config_ai_profile` action=add 添加'
  }
  const lines = profiles.map(p => profileLine(p, activeId))
  return `  - **AI 模型配置** — ${profiles.length} 个（勿用 config_set 整表覆盖；用 config_ai_profile 追加）\n${lines.join('\n')}`
}

export function formatAiProfilesDetail(store: AiProfileStore): string {
  const profiles = store.getAiProfiles()
  const activeId = store.getActiveAiProfile()
  if (profiles.length === 0) {
    return '_(未配置)_\n\n使用 `config_ai_profile` action=add 添加模型。'
  }
  const blocks = profiles.map((p, i) => {
    const parts = [
      `${i + 1}. **${p.name}**${p.id === activeId ? '（当前默认）' : ''}`,
      `- id: \`${p.id}\``,
      `- model: \`${p.model || ''}\``,
      `- apiUrl: \`${p.apiUrl || ''}\``,
      `- apiKey: ${redactKey(!!p.apiKey)}`,
      `- modelType: \`${p.modelType || 'general'}\``,
      `- apiFormat: \`${p.apiFormat || 'auto'}\``,
    ]
    if (p.contextLength != null) parts.push(`- contextLength: \`${p.contextLength}\``)
    if (p.maxOutputTokens != null) parts.push(`- maxOutputTokens: \`${p.maxOutputTokens}\``)
    if (p.temperature != null) parts.push(`- temperature: \`${p.temperature}\``)
    if (p.proxy) parts.push('- proxy: _(已配置)_')
    if (p.visionProfileId) parts.push(`- visionProfileId: \`${p.visionProfileId}\``)
    if (p.oemCatalogId) parts.push('- 公司提供的模型，不能改、不能删')
    return parts.join('\n')
  })
  return `共 ${profiles.length} 个：\n\n${blocks.join('\n\n')}\n\n增删改请用 \`config_ai_profile\`（action=add/update/delete），勿用 \`config_set\` 写入整表。`
}

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function argBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return undefined
}

function parseModelType(raw: string): AiModelType | undefined {
  if (!raw) return undefined
  if (!MODEL_TYPES.has(raw as AiModelType)) return undefined
  return raw as AiModelType
}

function parseApiFormat(raw: string): ApiFormat | undefined {
  if (!raw) return undefined
  if (!API_FORMATS.has(raw as ApiFormat)) return undefined
  return raw as ApiFormat
}

function validateApiUrl(apiUrl: string): string | undefined {
  try {
    const u = new URL(apiUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'apiUrl 须为 http 或 https 地址'
    }
    return undefined
  } catch {
    return 'apiUrl 不是合法地址'
  }
}

function validateVisionRef(store: AiProfileStore, visionProfileId: string, selfId?: string): string | undefined {
  if (!visionProfileId) return undefined
  if (selfId && visionProfileId === selfId) return 'visionProfileId 不能指向自己'
  const target = store.getAiProfiles().find(p => p.id === visionProfileId)
  if (!target) return `未找到 id 为 "${visionProfileId}" 的视觉模型`
  if (target.modelType !== 'vision') return `"${visionProfileId}" 不是视觉模型，不能作为关联`
  return undefined
}

async function testNote(
  testFn: AiProfileTestFn | undefined,
  profile: Partial<AiProfile>
): Promise<string> {
  if (!testFn) return ''
  try {
    const r = await testFn(profile)
    if (r.success) {
      return r.latencyMs != null
        ? `连接测试通过（${r.latencyMs}ms）。`
        : '连接测试通过。'
    }
    return `⚠️ 已保存，但连接测试失败：${r.message}。可稍后在设置页再测。`
  } catch (err) {
    return `⚠️ 已保存，但连接测试异常：${err instanceof Error ? err.message : String(err)}`
  }
}

export async function addAiProfileConfig(
  store: AiProfileStore,
  args: Record<string, unknown>,
  testFn?: AiProfileTestFn
): Promise<ToolResult> {
  const name = argStr(args, 'name')
  const apiUrl = argStr(args, 'apiUrl')
  const model = argStr(args, 'model')
  const apiKey = argStr(args, 'apiKey')
  if (!name || !apiUrl || !model || !apiKey) {
    return { success: false, output: '', error: '缺少必填参数: name, apiUrl, model, apiKey' }
  }

  const urlErr = validateApiUrl(apiUrl)
  if (urlErr) return { success: false, output: '', error: urlErr }

  const modelTypeRaw = argStr(args, 'modelType')
  const modelType = modelTypeRaw ? parseModelType(modelTypeRaw) : 'general'
  if (modelTypeRaw && !modelType) {
    return { success: false, output: '', error: 'modelType 须为 general 或 vision' }
  }

  const apiFormatRaw = argStr(args, 'apiFormat')
  const apiFormat = apiFormatRaw ? parseApiFormat(apiFormatRaw) : 'auto'
  if (apiFormatRaw && !apiFormat) {
    return { success: false, output: '', error: 'apiFormat 须为 auto、openai 或 anthropic' }
  }

  const contextLength = argNum(args, 'contextLength')
  if (contextLength !== undefined && Number.isNaN(contextLength)) {
    return { success: false, output: '', error: 'contextLength 须为数字' }
  }
  const maxOutputTokens = argNum(args, 'maxOutputTokens')
  if (maxOutputTokens !== undefined && Number.isNaN(maxOutputTokens)) {
    return { success: false, output: '', error: 'maxOutputTokens 须为数字' }
  }
  const temperature = argNum(args, 'temperature')
  if (temperature !== undefined && Number.isNaN(temperature)) {
    return { success: false, output: '', error: 'temperature 须为数字' }
  }

  const id = argStr(args, 'id') || uuidv4()
  if (store.getAiProfiles().some(p => p.id === id)) {
    return { success: false, output: '', error: `已存在 id 为 "${id}" 的模型配置` }
  }

  const visionProfileId = argStr(args, 'visionProfileId') || undefined
  const visionErr = validateVisionRef(store, visionProfileId || '', id)
  if (visionErr) return { success: false, output: '', error: visionErr }

  const profile: AiProfile = {
    id,
    name,
    apiUrl,
    apiKey,
    model,
    proxy: argStr(args, 'proxy') || undefined,
    contextLength: contextLength ?? 128000,
    maxOutputTokens,
    temperature,
    modelType,
    visionProfileId,
    apiFormat,
  }

  const wasEmpty = store.getAiProfiles().length === 0
  store.addAiProfile(profile)
  const setActive = argBool(args, 'setActive') === true || wasEmpty
  if (setActive) store.setActiveAiProfile(id)

  const n = store.getAiProfiles().length
  const note = await testNote(testFn, profile)
  const activeNote = setActive ? '已设为默认。' : '未改当前默认。'
  return {
    success: true,
    output: [
      `✅ 已添加 AI 模型 **${name}**（id: \`${id}\`，${model}）。当前共 ${n} 个。`,
      activeNote,
      note,
    ].filter(Boolean).join('\n'),
  }
}

export async function updateAiProfileConfig(
  store: AiProfileStore,
  args: Record<string, unknown>,
  testFn?: AiProfileTestFn
): Promise<ToolResult> {
  const profileId = argStr(args, 'profileId') || argStr(args, 'id')
  if (!profileId) return { success: false, output: '', error: '缺少 profileId（或 id）参数' }

  const existing = store.getAiProfiles().find(p => p.id === profileId)
  if (!existing) {
    return { success: false, output: '', error: `未找到 id 为 "${profileId}" 的模型配置` }
  }
  if (existing.oemCatalogId) {
    return { success: false, output: '', error: `**${existing.name}** 是公司提供的模型，不能改。要换用自己的，请另加一条。` }
  }

  const name = args.name !== undefined ? argStr(args, 'name') : existing.name
  if (!name) return { success: false, output: '', error: 'name 不能为空' }

  const apiUrl = args.apiUrl !== undefined ? argStr(args, 'apiUrl') : existing.apiUrl
  if (!apiUrl) return { success: false, output: '', error: 'apiUrl 不能为空' }
  const urlErr = validateApiUrl(apiUrl)
  if (urlErr) return { success: false, output: '', error: urlErr }

  const model = args.model !== undefined ? argStr(args, 'model') : existing.model
  if (!model) return { success: false, output: '', error: 'model 不能为空' }

  const apiKey = args.apiKey !== undefined ? argStr(args, 'apiKey') : existing.apiKey
  if (args.apiKey !== undefined && !apiKey) {
    return { success: false, output: '', error: 'apiKey 不能为空（省略该参数可保留原 Key）' }
  }

  let modelType = existing.modelType || 'general'
  if (args.modelType !== undefined) {
    const parsed = parseModelType(argStr(args, 'modelType'))
    if (!parsed) return { success: false, output: '', error: 'modelType 须为 general 或 vision' }
    modelType = parsed
  }

  let apiFormat = existing.apiFormat || 'auto'
  if (args.apiFormat !== undefined) {
    const parsed = parseApiFormat(argStr(args, 'apiFormat'))
    if (!parsed) return { success: false, output: '', error: 'apiFormat 须为 auto、openai 或 anthropic' }
    apiFormat = parsed
  }

  let contextLength = existing.contextLength
  if (args.contextLength !== undefined) {
    const n = argNum(args, 'contextLength')
    if (n === undefined || Number.isNaN(n)) return { success: false, output: '', error: 'contextLength 须为数字' }
    contextLength = n
  }

  let maxOutputTokens = existing.maxOutputTokens
  if (args.maxOutputTokens !== undefined) {
    if (args.maxOutputTokens === null || args.maxOutputTokens === '') {
      maxOutputTokens = undefined
    } else {
      const n = argNum(args, 'maxOutputTokens')
      if (n === undefined || Number.isNaN(n)) return { success: false, output: '', error: 'maxOutputTokens 须为数字' }
      maxOutputTokens = n
    }
  }

  let temperature = existing.temperature
  if (args.temperature !== undefined) {
    if (args.temperature === null || args.temperature === '') {
      temperature = undefined
    } else {
      const n = argNum(args, 'temperature')
      if (n === undefined || Number.isNaN(n)) return { success: false, output: '', error: 'temperature 须为数字' }
      temperature = n
    }
  }

  let visionProfileId = existing.visionProfileId
  if (args.visionProfileId !== undefined) {
    const raw = argStr(args, 'visionProfileId')
    visionProfileId = raw || undefined
  }
  const visionErr = validateVisionRef(store, visionProfileId || '', profileId)
  if (visionErr) return { success: false, output: '', error: visionErr }

  const proxy = args.proxy !== undefined
    ? (argStr(args, 'proxy') || undefined)
    : existing.proxy

  const merged: AiProfile = {
    ...existing,
    name,
    apiUrl,
    apiKey,
    model,
    proxy,
    contextLength,
    maxOutputTokens,
    temperature,
    modelType,
    visionProfileId,
    apiFormat,
  }

  store.updateAiProfile(merged)
  const setActive = argBool(args, 'setActive') === true
  if (setActive) store.setActiveAiProfile(profileId)

  const note = await testNote(testFn, merged)
  const activeNote = setActive ? '已设为默认。' : ''
  return {
    success: true,
    output: [`✅ 已更新 AI 模型 **${name}**（\`${profileId}\`）。`, activeNote, note].filter(Boolean).join('\n'),
  }
}

export function deleteAiProfileConfig(
  store: AiProfileStore,
  args: Record<string, unknown>,
  inUseProfileId?: string
): ToolResult {
  const profileId = argStr(args, 'profileId') || argStr(args, 'id')
  if (!profileId) return { success: false, output: '', error: '缺少 profileId（或 id）参数' }

  const profiles = store.getAiProfiles()
  const found = profiles.find(p => p.id === profileId)
  if (!found) {
    return { success: false, output: '', error: `未找到 id 为 "${profileId}" 的模型配置` }
  }
  if (found.oemCatalogId) {
    return { success: false, output: '', error: `**${found.name}** 是公司提供的模型，不能删。不用它时，换一条自己的即可。` }
  }

  if (profiles.length <= 1) {
    return {
      success: false,
      output: '',
      error: `**${found.name}** 是最后一条模型配置，删掉后秘书自己也没法继续。请先加上别的再删。`,
    }
  }

  const inUse = inUseProfileId
    ? profiles.find(p => p.id === inUseProfileId)
    : undefined
  const linkedVisionId = inUse?.visionProfileId
  if (inUse && profileId === inUse.id) {
    return {
      success: false,
      output: '',
      error: `**${found.name}** 是当前对话正在用的模型，不能删。请先换一个，或只删其他配置。`,
    }
  }
  if (linkedVisionId && profileId === linkedVisionId) {
    return {
      success: false,
      output: '',
      error: `**${found.name}** 是当前模型关联的视觉模型，不能删。请先换一个主模型或解除关联。`,
    }
  }

  const referrers = profiles.filter(p => p.id !== profileId && p.visionProfileId === profileId)
  if (referrers.length && argBool(args, 'confirmUnlink') !== true) {
    const names = referrers.map(p => `**${p.name}**`).join('、')
    return {
      success: false,
      output: '',
      error: `**${found.name}** 还被 ${names} 当作视觉模型。删掉会解除这些关联。请先问用户是否继续；同意后再带 confirmUnlink=true 删除。`,
    }
  }

  store.setAiProfiles(
    profiles
      .filter(p => p.id !== profileId)
      .map(p => (p.visionProfileId === profileId ? { ...p, visionProfileId: undefined } : p))
  )

  const remaining = store.getAiProfiles()
  if (store.getActiveAiProfile() === profileId) {
    store.setActiveAiProfile(remaining[0]?.id || '')
  }

  const n = remaining.length
  const unlinkNote = referrers.length
    ? `已解除 ${referrers.map(p => `**${p.name}**`).join('、')} 对该模型的视觉关联。`
    : ''
  return {
    success: true,
    output: [`✅ 已删除 AI 模型 **${found.name}**（\`${profileId}\`）。剩余 ${n} 个。`, unlinkNote]
      .filter(Boolean)
      .join('\n'),
  }
}

export async function executeAiProfileAction(
  store: AiProfileStore,
  args: Record<string, unknown>,
  opts?: { testFn?: AiProfileTestFn; inUseProfileId?: string }
): Promise<ToolResult> {
  const action = argStr(args, 'action')
  if (action === 'add') return addAiProfileConfig(store, args, opts?.testFn)
  if (action === 'update') return updateAiProfileConfig(store, args, opts?.testFn)
  if (action === 'delete') return deleteAiProfileConfig(store, args, opts?.inUseProfileId)
  return { success: false, output: '', error: 'action 须为 add、update 或 delete' }
}
