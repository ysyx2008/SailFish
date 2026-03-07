/**
 * 个性定义技能 - 执行器
 * 读取、预览和写入 Agent 身份文件（IDENTITY.md）
 */

import * as fs from 'fs'
import * as path from 'path'
import { getConfigService } from '../../../config.service'
import { getMbtiStylePrompt, readIdentityFile } from '../../prompt-builder'
import { t } from '../../i18n'
import { notifyFrontendConfigChanged } from '../config/executor'
import { getWorkspacePath } from '../../tools/file'
import { createLogger } from '../../../../utils/logger'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'
import type { AgentMbtiType } from '@shared/types'

const log = createLogger('PersonalityExecutor')
const IDENTITY_FILENAME = 'IDENTITY.md'
const VALID_MBTI_TYPES = new Set([
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP'
])

function writeIdentityFile(content: string): boolean {
  try {
    const workspace = getWorkspacePath()
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, IDENTITY_FILENAME), content, 'utf-8')
    return true
  } catch (err) {
    log.error('Failed to write IDENTITY.md:', err)
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

  const fileWritten = writeIdentityFile(personalityText)
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
    `> 字符数: ${personalityText.length}`,
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
