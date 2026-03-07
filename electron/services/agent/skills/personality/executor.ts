/**
 * 个性定义技能 - 执行器
 * 读取、预览和写入 Agent 身份文件（IDENTITY.md / SOUL.md / USER.md）
 */

import * as fs from 'fs'
import * as path from 'path'
import { getConfigService } from '../../../config.service'
import { getMbtiStylePrompt, readIdentityFile, readSoulFile, readUserFile } from '../../prompt-builder'
import { t } from '../../i18n'
import { notifyFrontendConfigChanged } from '../config/executor'
import { getWorkspacePath } from '../../tools/file'
import { createLogger } from '../../../../utils/logger'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'
import type { AgentMbtiType } from '@shared/types'

const log = createLogger('PersonalityExecutor')
const IDENTITY_FILENAME = 'IDENTITY.md'
const SOUL_FILENAME = 'SOUL.md'
const USER_FILENAME = 'USER.md'
const IDENTITY_MAX_LENGTH = 1000
const SOUL_MAX_LENGTH = 1000
const USER_MAX_LENGTH = 1000
const VALID_MBTI_TYPES = new Set([
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP'
])

function writeWorkspaceFile(filename: string, content: string): boolean {
  try {
    const workspace = getWorkspacePath()
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, filename), content, 'utf-8')
    return true
  } catch (err) {
    log.error(`Failed to write ${filename}:`, err)
    return false
  }
}

export async function executePersonalityTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'personality_get':
      return getPersonality(executor)
    case 'personality_craft':
      return craftPersonality(args, executor)
    case 'personality_preview':
      return previewPersonality(args, executor)
    case 'soul_craft':
      return craftSoul(args, executor)
    case 'user_craft':
      return craftUser(args, executor)
    default:
      return { success: false, output: '', error: t('personality.unknown_tool', { name: toolName }) }
  }
}

function getPersonality(executor: ToolExecutorConfig): ToolResult {
  const config = getConfigService()
  const identityContent = readIdentityFile()
  const mbti = config.getAgentMbti() || null
  const name = config.getAgentName() || ''

  executor.addStep({
    type: 'tool_call',
    content: t('personality.reading'),
    toolName: 'personality_get',
    toolArgs: {},
    riskLevel: 'safe'
  })

  const sections: string[] = []

  sections.push(`### 名字\n${name || t('personality.name_default')}`)

  if (mbti) {
    const mbtiStyle = getMbtiStylePrompt(mbti)
    sections.push(`### MBTI 类型\n**${mbti}**${mbtiStyle ? `\n${mbtiStyle}` : ''}`)
  } else {
    sections.push(`### MBTI 类型\n${t('personality.not_set')}`)
  }

  if (identityContent) {
    sections.push(`### 身份描述（IDENTITY.md）\n${identityContent}`)
  } else {
    sections.push(`### 身份描述\n${t('personality.using_default')}`)
  }

  const soulContent = readSoulFile()
  if (soulContent) {
    sections.push(`### 行为灵魂（SOUL.md）\n${soulContent}`)
  } else {
    sections.push(`### 行为灵魂\n${t('personality.not_set')}`)
  }

  const userContent = readUserFile()
  if (userContent) {
    sections.push(`### 用户画像（USER.md）\n${userContent}`)
  } else {
    sections.push(`### 用户画像\n${t('personality.not_set')}`)
  }

  const output = `## 当前个性配置\n\n${sections.join('\n\n')}`

  executor.addStep({
    type: 'tool_result',
    content: t('personality.read_done'),
    toolName: 'personality_get',
    toolResult: output.length > 500 ? output.substring(0, 500) + '...' : output
  })

  return { success: true, output }
}

function craftPersonality(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const personalityText = (args.personality_text as string || '').trim()
  const name = args.name !== undefined ? (args.name as string || '').trim() : undefined
  const mbti = args.mbti as string | undefined

  if (!personalityText) {
    return { success: false, output: '', error: t('personality.text_empty') }
  }

  if (personalityText.length > IDENTITY_MAX_LENGTH) {
    return {
      success: false, output: '',
      error: t('personality.text_too_long', { current: personalityText.length, max: IDENTITY_MAX_LENGTH })
    }
  }

  if (mbti && !VALID_MBTI_TYPES.has(mbti)) {
    return { success: false, output: '', error: t('personality.invalid_mbti', { mbti }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('personality.writing'),
    toolName: 'personality_craft',
    toolArgs: { personality_text: personalityText.substring(0, 100) + (personalityText.length > 100 ? '...' : ''), name, mbti },
    riskLevel: 'safe'
  })

  const config = getConfigService()
  const changes: string[] = []

  const fileWritten = writeWorkspaceFile(IDENTITY_FILENAME, personalityText)
  config.setAgentPersonalityText(personalityText)
  changes.push(fileWritten
    ? `IDENTITY.md（${personalityText.length} 字符）`
    : `个性定义（${personalityText.length} 字符，IDENTITY.md 写入失败，已存入配置）`)

  if (name !== undefined) {
    config.setAgentName(name)
    changes.push(`名字 → ${name || t('personality.name_default')}`)
  }

  if (mbti) {
    config.setAgentMbti(mbti as AgentMbtiType)
    changes.push(`MBTI → ${mbti}`)
  }

  notifyFrontendConfigChanged()

  const output = `✅ ${t('personality.written')}\n\n**已修改**:\n${changes.map(c => `- ${c}`).join('\n')}`

  executor.addStep({
    type: 'tool_result',
    content: t('personality.written'),
    toolName: 'personality_craft'
  })

  return { success: true, output }
}

function previewPersonality(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const personalityText = (args.personality_text as string || '').trim()
  const name = (args.name as string || '').trim()
  const mbti = args.mbti as string | undefined

  if (!personalityText) {
    return { success: false, output: '', error: t('personality.text_empty') }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('personality.previewing'),
    toolName: 'personality_preview',
    toolArgs: { personality_text: personalityText.substring(0, 100) + (personalityText.length > 100 ? '...' : '') },
    riskLevel: 'safe'
  })

  const config = getConfigService()
  const displayName = name || config.getAgentName() || '旗鱼'
  const effectiveMbti = mbti || config.getAgentMbti() || null
  const mbtiStyle = effectiveMbti ? getMbtiStylePrompt(effectiveMbti as AgentMbtiType) : ''

  let personalitySection = ''
  if (personalityText && mbtiStyle) {
    personalitySection = `## 你的个性（重要！）\n${personalityText}\n\n### 风格参考（MBTI: ${effectiveMbti}）\n${mbtiStyle}`
  } else if (personalityText) {
    personalitySection = `## 你的个性（重要！）\n${personalityText}`
  }

  const output = [
    '### 预览效果',
    '',
    '以下是个性定义在 system prompt 中的呈现：',
    '',
    '---',
    '',
    `你是**${displayName}**，一个能帮助用户完成各类任务的智能助手。`,
    '',
    personalitySection,
    '',
    '---',
    '',
    `> 字符数: ${personalityText.length}/${IDENTITY_MAX_LENGTH}`,
    `> ${t('personality.confirm_hint')}`,
  ].join('\n')

  executor.addStep({
    type: 'tool_result',
    content: t('personality.preview_done'),
    toolName: 'personality_preview',
    toolResult: output.length > 500 ? output.substring(0, 500) + '...' : output
  })

  return { success: true, output }
}

function craftSoul(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const soulText = (args.soul_text as string || '').trim()

  if (!soulText) {
    return { success: false, output: '', error: t('personality.soul_empty') }
  }

  if (soulText.length > SOUL_MAX_LENGTH) {
    return {
      success: false, output: '',
      error: t('personality.soul_too_long', { current: soulText.length, max: SOUL_MAX_LENGTH })
    }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('personality.soul_writing'),
    toolName: 'soul_craft',
    toolArgs: { soul_text: soulText.substring(0, 100) + (soulText.length > 100 ? '...' : '') },
    riskLevel: 'safe'
  })

  const fileWritten = writeWorkspaceFile(SOUL_FILENAME, soulText)

  const output = fileWritten
    ? `✅ ${t('personality.soul_written')}\n\n**SOUL.md**（${soulText.length} 字符）`
    : `⚠️ SOUL.md 写入失败`

  executor.addStep({
    type: 'tool_result',
    content: fileWritten ? t('personality.soul_written') : 'SOUL.md write failed',
    toolName: 'soul_craft'
  })

  return { success: fileWritten, output, error: fileWritten ? undefined : 'Failed to write SOUL.md' }
}

function craftUser(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const userText = (args.user_text as string || '').trim()

  if (!userText) {
    return { success: false, output: '', error: t('personality.user_empty') }
  }

  if (userText.length > USER_MAX_LENGTH) {
    return {
      success: false, output: '',
      error: t('personality.user_too_long', { current: userText.length, max: USER_MAX_LENGTH })
    }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('personality.user_writing'),
    toolName: 'user_craft',
    toolArgs: { user_text: userText.substring(0, 100) + (userText.length > 100 ? '...' : '') },
    riskLevel: 'safe'
  })

  const fileWritten = writeWorkspaceFile(USER_FILENAME, userText)

  const output = fileWritten
    ? `✅ ${t('personality.user_written')}\n\n**USER.md**（${userText.length} 字符）`
    : `⚠️ USER.md 写入失败`

  executor.addStep({
    type: 'tool_result',
    content: fileWritten ? t('personality.user_written') : 'USER.md write failed',
    toolName: 'user_craft'
  })

  return { success: fileWritten, output, error: fileWritten ? undefined : 'Failed to write USER.md' }
}
