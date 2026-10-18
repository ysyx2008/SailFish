/**
 * 用户技能创建执行器
 */
import * as fs from 'fs'
import * as path from 'path'
import { getUserSkillService } from '../../../user-skill.service'
import { getSkillMarketService, skillHubLocalId, type MarketSkill, type SkillSource } from '../../../skill-market.service'
import { getConfigService } from '../../../config.service'
import { setSkillEnv, deleteSkillEnv, listSkillEnvNames } from '../../../credential.service'
import { createLogger } from '../../../../utils/logger'
import { t } from '../../i18n'
import { riskNeedsConfirm } from '../../command-audit/confirm-policy'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'

const log = createLogger('skill-creator')

/**
 * 执行用户技能创建工具
 */
export async function executeSkillCreatorTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'skill_create':
      return createSkill(args, executor)
    case 'skill_list':
      return listSkills(args)
    case 'skill_delete':
      return deleteSkill(args, executor)
    case 'skill_update':
      return updateSkill(args, executor)
    case 'skill_get_path':
      return getSkillsPath()
    case 'skill_set_env':
      return setSkillEnvTool(args, toolCallId, executor)
    case 'skill_list_env':
      return listSkillEnvTool(args)
    case 'skill_delete_env':
      return deleteSkillEnvTool(args, executor)
    case 'skill_market_search':
      return marketSearch(args)
    case 'skill_preview':
    case 'skill_market_preview':
      return skillPreview(args)
    case 'skill_market_install':
      return marketInstall(args, toolCallId, config, executor)
    case 'skill_install_local':
      return installLocal(args, toolCallId, config, executor)
    default:
      return { success: false, output: '', error: `未知的技能管理工具: ${toolName}` }
  }
}

/**
 * 验证技能 ID 格式
 */
function isValidSkillId(id: string): boolean {
  // 只允许小写字母、数字、连字符
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(id)
}

/**
 * 生成 SKILL.md 文件内容
 */
function generateSkillContent(
  name: string,
  description: string,
  content: string,
  version: string = '1.0'
): string {
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version}`,
    'enabled: true',
    '---'
  ].join('\n')

  return `${frontmatter}\n\n${content}`
}

/**
 * 创建用户技能
 */
async function createSkill(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim().toLowerCase()
  const name = (args.name as string)?.trim()
  const description = (args.description as string)?.trim()
  const content = (args.content as string)?.trim()
  const version = (args.version as string)?.trim() || '1.0'

  // 参数验证
  if (!skillId) {
    return { success: false, output: '', error: '技能 ID 不能为空' }
  }
  if (!isValidSkillId(skillId)) {
    return { 
      success: false, 
      output: '', 
      error: '技能 ID 格式无效。只能包含小写字母、数字和连字符（如 video-downloader）' 
    }
  }
  if (!name) {
    return { success: false, output: '', error: '技能名称不能为空' }
  }
  if (!description) {
    return { success: false, output: '', error: '技能描述不能为空' }
  }
  if (!content) {
    return { success: false, output: '', error: '技能内容不能为空' }
  }

  try {
    const userSkillService = getUserSkillService()
    const skillsDir = userSkillService.getSkillsDir()

    // 检查技能是否已存在
    const existingSkill = userSkillService.getSkill(skillId)
    if (existingSkill) {
      return { 
        success: false, 
        output: '', 
        error: `技能 "${skillId}" 已存在。使用 skill_update 更新或 skill_delete 删除后重新创建。` 
      }
    }

    // 创建技能目录
    const skillDir = path.join(skillsDir, skillId)
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }

    // 生成并写入 SKILL.md
    const skillFilePath = path.join(skillDir, 'SKILL.md')
    const fileContent = generateSkillContent(name, description, content, version)
    fs.writeFileSync(skillFilePath, fileContent, 'utf-8')

    // 刷新技能缓存
    userSkillService.refresh()

    log.info(`Created skill: ${skillId} (${name}) at ${skillFilePath}`)

    executor.addStep({
      type: 'tool_result',
      content: `✅ 技能创建成功: ${name}`,
      toolName: 'skill_create',
      toolResult: `技能已保存到: ${skillFilePath}`
    })

    return {
      success: true,
      output: `✅ 用户技能创建成功

**技能信息**
- ID: ${skillId}
- 名称: ${name}
- 版本: ${version}
- 文件: ${skillFilePath}

**使用方式**
调用 skill load "${skillId}" 加载此技能。`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `创建技能失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 列出所有用户技能
 */
async function listSkills(args: Record<string, unknown>): Promise<ToolResult> {
  const includeDisabled = args.include_disabled as boolean ?? true

  try {
    const userSkillService = getUserSkillService()
    let skills = userSkillService.getAllSkills()

    if (!includeDisabled) {
      skills = skills.filter(s => s.enabled)
    }

    if (skills.length === 0) {
      return {
        success: true,
        output: '暂无用户技能。使用 skill_create 创建新技能。'
      }
    }

    const skillList = skills.map(skill => {
      const status = skill.enabled ? '✓ 启用' : '○ 禁用'
      const desc = skill.description ? `\n  描述: ${skill.description}` : ''
      const ver = skill.version ? ` v${skill.version}` : ''
      
      return `- **${skill.name}**${ver} [${status}]
  ID: ${skill.id}${desc}
  文件: ${skill.filePath}`
    }).join('\n\n')

    return {
      success: true,
      output: `共 ${skills.length} 个用户技能：\n\n${skillList}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `获取技能列表失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 删除用户技能
 */
async function deleteSkill(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim().toLowerCase()

  if (!skillId) {
    return { success: false, output: '', error: '技能 ID 不能为空' }
  }

  try {
    const userSkillService = getUserSkillService()
    const skill = userSkillService.getSkill(skillId)

    if (!skill) {
      return { success: false, output: '', error: `技能不存在: ${skillId}` }
    }

    const skillName = skill.name
    const skillDir = path.dirname(skill.filePath)
    const skillsDir = userSkillService.getSkillsDir()

    // 判断是目录形式还是文件形式
    if (skill.filePath.endsWith('SKILL.md') && skillDir !== skillsDir) {
      // 目录形式：删除整个目录
      fs.rmSync(skillDir, { recursive: true, force: true })
    } else {
      // 文件形式：只删除文件
      fs.unlinkSync(skill.filePath)
    }

    // 刷新缓存
    userSkillService.refresh()

    log.info(`Deleted skill: ${skillId} (${skillName})`)

    executor.addStep({
      type: 'tool_result',
      content: `✅ 已删除技能: ${skillName}`,
      toolName: 'skill_delete',
      toolResult: `技能 ${skillId} 已删除`
    })

    return {
      success: true,
      output: `✅ 已删除技能：${skillName} (${skillId})`
    }
  } catch (error) {
    log.error(`Failed to delete skill ${skillId}:`, error)
    return {
      success: false,
      output: '',
      error: `删除技能失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 更新用户技能
 */
async function updateSkill(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim().toLowerCase()
  const newName = (args.name as string)?.trim()
  const newDescription = (args.description as string)?.trim()
  const newContent = (args.content as string)?.trim()
  const newVersion = (args.version as string)?.trim()

  if (!skillId) {
    return { success: false, output: '', error: '技能 ID 不能为空' }
  }

  // 至少要更新一项
  if (!newName && !newDescription && !newContent && !newVersion) {
    return { success: false, output: '', error: '至少需要指定一个要更新的字段（name、description、content 或 version）' }
  }

  try {
    const userSkillService = getUserSkillService()
    const skill = userSkillService.getSkill(skillId)

    if (!skill) {
      return { success: false, output: '', error: `技能不存在: ${skillId}` }
    }

    // 读取现有内容
    const existingContent = fs.readFileSync(skill.filePath, 'utf-8')
    
    // 解析 frontmatter
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/
    const match = existingContent.match(frontmatterRegex)
    
    let name = skill.name
    let description = skill.description
    let version = skill.version || '1.0'
    let content = skill.content
    let enabled = skill.enabled

    if (match) {
      // 从 frontmatter 解析现有值
      const yamlStr = match[1]
      const body = match[2] || ''
      content = body.trim()

      // 解析 enabled
      const enabledMatch = yamlStr.match(/^enabled\s*:\s*(.+)$/m)
      if (enabledMatch) {
        enabled = enabledMatch[1].trim().toLowerCase() !== 'false'
      }
    }

    // 应用更新
    if (newName) name = newName
    if (newDescription) description = newDescription
    if (newContent) {
      // 如果 newContent 包含 frontmatter，需要先移除它，避免 frontmatter 重复
      const contentMatch = newContent.match(frontmatterRegex)
      if (contentMatch) {
        content = (contentMatch[2] || '').trim()
      } else {
        content = newContent
      }
    }
    if (newVersion) version = newVersion

    // 生成新内容
    const updatedFileContent = generateSkillContent(name, description, content, version)
    
    // 如果技能是禁用的，保持禁用状态
    let finalContent = updatedFileContent
    if (!enabled) {
      finalContent = updatedFileContent.replace('enabled: true', 'enabled: false')
    }

    // 写入文件
    fs.writeFileSync(skill.filePath, finalContent, 'utf-8')

    // 刷新缓存
    userSkillService.refresh()

    const updatedFields: string[] = []
    if (newName) updatedFields.push('名称')
    if (newDescription) updatedFields.push('描述')
    if (newContent) updatedFields.push('内容')
    if (newVersion) updatedFields.push('版本')

    executor.addStep({
      type: 'tool_result',
      content: `✅ 技能已更新: ${name}`,
      toolName: 'skill_update',
      toolResult: `更新了: ${updatedFields.join('、')}`
    })

    return {
      success: true,
      output: `✅ 技能更新成功

**技能信息**
- ID: ${skillId}
- 名称: ${name}
- 版本: ${version}
- 更新内容: ${updatedFields.join('、')}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `更新技能失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 获取用户技能目录路径
 */
async function getSkillsPath(): Promise<ToolResult> {
  try {
    const userSkillService = getUserSkillService()
    const skillsDir = userSkillService.getSkillsDir()

    return {
      success: true,
      output: `用户技能目录: ${skillsDir}

**目录结构说明**
技能可以是目录形式或文件形式：

1. 目录形式（推荐）：
   ${skillsDir}/my-skill/SKILL.md

2. 文件形式：
   ${skillsDir}/my-skill.md

**SKILL.md 格式**
\`\`\`markdown
---
name: 技能名称
description: 技能描述
version: 1.0
enabled: true
---

# 技能标题

技能正文内容（Markdown 格式）
\`\`\``
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `获取技能目录失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

// ==================== 技能 env key 管理工具 ====================

/**
 * 设置技能 env key
 */
async function setSkillEnvTool(
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim()
  const envName = (args.env_name as string)?.trim().toUpperCase()
  const value = args.value as string | undefined

  if (!skillId) return { success: false, output: '', error: '技能 ID 不能为空' }
  if (!envName) return { success: false, output: '', error: 'env 变量名不能为空' }

  const userSkillService = getUserSkillService()
  const skill = userSkillService.getSkill(skillId)
  if (!skill) return { success: false, output: '', error: `技能不存在: ${skillId}` }

  // 检查是否已配置过（用于弹框提示"更新"还是"新建"）
  const existing = (await listSkillEnvNames(skillId)).includes(envName)

  if (value !== undefined && value !== '') {
    // 用户已在对话中提供了值，直接存储
    await setSkillEnv(skillId, envName, value)
    log.info(`Skill env set via direct value: ${skillId}:${envName}`)
    executor.addStep({
      type: 'tool_result',
      content: `✅ ${skill.name} 的 ${envName} 已配置`,
      toolName: 'skill_set_env',
      toolResult: `已为技能 ${skillId} 存储 ${envName}`
    })
    return { success: true, output: `✅ 已为技能 **${skill.name}** 配置 \`${envName}\`` }
  }

  // 没有提供值：触发前端安全输入框
  executor.addStep({
    type: 'waiting_input',
    content: `请输入 **${skill.name}** 的 \`${envName}\``,
    toolName: 'skill_set_env',
    toolArgs: { skill_id: skillId, env_name: envName }
  })

  const saved = await executor.requestSecureInput(
    skillId,
    envName,
    `请输入 ${skill.name} 的 ${envName}`,
    existing
  )

  if (!saved) {
    executor.addStep({
      type: 'tool_result',
      content: `⛔ 用户取消了 ${envName} 的输入`,
      toolName: 'skill_set_env',
      toolResult: '用户取消'
    })
    return { success: false, output: '', error: '用户取消了输入' }
  }

  log.info(`Skill env set via secure input: ${skillId}:${envName}`)
  executor.addStep({
    type: 'tool_result',
    content: `✅ ${skill.name} 的 ${envName} 已配置`,
    toolName: 'skill_set_env',
    toolResult: `已为技能 ${skillId} 存储 ${envName}`
  })
  return { success: true, output: `✅ 已为技能 **${skill.name}** 配置 \`${envName}\`` }
}

/**
 * 列出技能的 env key 配置状态
 */
async function listSkillEnvTool(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim()
  if (!skillId) return { success: false, output: '', error: '技能 ID 不能为空' }

  const userSkillService = getUserSkillService()
  const skill = userSkillService.getSkill(skillId)
  if (!skill) return { success: false, output: '', error: `技能不存在: ${skillId}` }

  const statuses = await userSkillService.getSkillEnvStatus(skillId)

  if (statuses.length === 0) {
    return {
      success: true,
      output: `技能 **${skill.name}** 未声明任何 env key（\`requires.env\` 为空）。\n\n如需在 SKILL.md 中声明，格式如下：\n\`\`\`yaml\nmetadata: {"clawdbot": {"requires": {"env": ["MY_API_KEY"]}}}\n\`\`\`\n注意：metadata 的值必须写在同一行，且是合法 JSON 格式。`
    }
  }

  const lines = statuses.map(s =>
    `- \`${s.name}\`: ${s.configured ? '✅ 已配置' : '❌ 未配置'}`
  )
  const missing = statuses.filter(s => !s.configured)
  const hint = missing.length > 0
    ? `\n\n缺少 ${missing.length} 个 key，使用 \`skill_set_env\` 配置，或用 \`exec(..., skill_id="${skillId}")\` 确认已注入。`
    : '\n\n所有 key 均已配置，执行技能脚本时使用 `exec(..., skill_id="' + skillId + '")` 自动注入。'

  return {
    success: true,
    output: `**${skill.name}** 的 env key 状态：\n\n${lines.join('\n')}${hint}`
  }
}

/**
 * 删除技能的某个 env key
 */
async function deleteSkillEnvTool(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim()
  const envName = (args.env_name as string)?.trim().toUpperCase()

  if (!skillId) return { success: false, output: '', error: '技能 ID 不能为空' }
  if (!envName) return { success: false, output: '', error: 'env 变量名不能为空' }

  const removed = await deleteSkillEnv(skillId, envName)
  if (!removed) {
    return { success: false, output: '', error: `${skillId} 的 ${envName} 未配置，无需删除` }
  }

  log.info(`Skill env deleted: ${skillId}:${envName}`)
  executor.addStep({
    type: 'tool_result',
    content: `🗑️ 已删除 ${skillId} 的 ${envName}`,
    toolName: 'skill_delete_env',
    toolResult: `已删除 ${skillId}:${envName}`
  })
  return { success: true, output: `✅ 已删除技能 **${skillId}** 的 \`${envName}\` 配置` }
}

// ==================== 技能市场工具 ====================

function getMarketService() {
  return getSkillMarketService(getConfigService(), getUserSkillService())
}

/**
 * 搜索技能市场
 */
async function marketSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = (args.query as string)?.trim()
  if (!query) {
    return { success: false, output: '', error: '搜索关键词不能为空' }
  }

  const source = (args.source as string) || 'all'

  try {
    const service = getMarketService()
    const installed = getUserSkillService().getAllSkills()
    const want = (name: string) => source === 'all' || source === name

    const empty = { skills: [] as MarketSkill[], unavailable: false }
    const [sfResults, chOutcome, shOutcome] = await Promise.all([
      want('sailfish') ? service.searchSkills(query) : Promise.resolve([]),
      want('clawhub') ? service.searchClawHubResult(query) : Promise.resolve(empty),
      want('skillhub') ? service.searchSkillHubResult(query) : Promise.resolve(empty),
    ])
    const chResults = chOutcome.skills
    const shResults = shOutcome.skills

    const results: Array<{ id: string; name: string; description: string; author: string; source: string; version: string; installed: boolean }> = []

    for (const s of sfResults) {
      results.push({
        id: s.id,
        name: s.name,
        description: s.description,
        author: s.author,
        source: 'sailfish',
        version: s.version,
        installed: s.installed,
      })
    }

    for (const s of chResults) {
      results.push({
        id: s.id,
        name: s.name,
        description: s.description,
        author: s.author,
        source: 'clawhub',
        version: s.version,
        installed: installed.some(local => local.id === s.id),
      })
    }

    for (const s of shResults) {
      results.push({
        id: s.id,
        name: s.name,
        description: s.description,
        author: s.author,
        source: 'skillhub',
        version: s.version,
        installed: installed.some(local => local.id === skillHubLocalId(s.id)),
      })
    }

    const down = [
      chOutcome.unavailable ? 'ClawHub 暂时不可用' : '',
      shOutcome.unavailable ? 'SkillHub 暂时不可用' : '',
    ].filter(Boolean)
    const downNote = down.length ? `\n\n${down.join('；')}。` : ''

    if (results.length === 0) {
      return { success: true, output: `未找到与 "${query}" 相关的技能。${downNote}` }
    }

    const lines = results.map(r => {
      const badge = r.source === 'clawhub' ? '[ClawHub]' : r.source === 'skillhub' ? '[SkillHub]' : '[SailFish]'
      const status = r.installed ? ' ✓已安装' : ''
      return `- **${r.name}** (${r.id}) ${badge}${status}\n  ${r.description}\n  作者: ${r.author} | 版本: ${r.version}`
    })

    return {
      success: true,
      output: `找到 ${results.length} 个技能：\n\n${lines.join('\n\n')}${downNote}\n\n使用 \`skill_preview\` 查看详情和安全审查，然后用 \`skill_market_install\` 安装。SkillHub 的 ID 是搜索结果里的 @作者/名称。`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `搜索失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

const STRUCTURAL_WARN_I18N: Record<
  import('../../../skill-market.service').SecurityWarning['type'],
  string
> = {
  hidden_content: 'scan.warn_hidden_content',
  encoding_obfuscation: 'scan.warn_encoding_obfuscation',
}

/**
 * 预览技能内容并做结构隐蔽扫描（统一支持市场和本地来源）。
 * 语义安全由 Agent 审阅返回正文后判断。
 */
async function skillPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim()
  const source = (args.source as string) || 'sailfish'

  if (!skillId) {
    return { success: false, output: '', error: t('scan.id_required') }
  }

  try {
    const service = getMarketService()
    let result: import('../../../skill-market.service').SkillPreviewResult & { filesMap?: Record<string, string> }

    if (source === 'local') {
      result = service.previewLocalSkill(skillId, { resolveInstalledId: true })
    } else {
      result = await service.previewSkill(skillId, source as SkillSource)
    }

    if (!result.success || !result.content) {
      return { success: false, output: '', error: result.error || t('scan.preview_failed') }
    }

    const scan = result.scan!
    const skill = result.skill!

    let scanSection: string
    if (scan.safe) {
      scanSection = t('scan.status_passed')
    } else {
      const warningLines = scan.warnings.map(w =>
        `- ⚠️ **${w.type}**: ${t(STRUCTURAL_WARN_I18N[w.type] as any, { evidence: w.evidence }) || w.description}\n  ${t('scan.evidence')}: \`${w.evidence}\``
      )
      scanSection = t('scan.status_warnings', { count: scan.warnings.length }) + '\n\n' + warningLines.join('\n')
    }

    const sourceLabel = source === 'clawhub'
      ? 'ClawHub'
      : source === 'skillhub'
        ? 'SkillHub'
        : source === 'local'
          ? t('scan.source_local')
          : 'SailFish'
    const permissionsLine = skill.permissions?.length
      ? `${t('scan.permissions')}: ${skill.permissions.join(', ')}`
      : `${t('scan.permissions')}: ${t('scan.none')}`

    const filesLine = result.files && result.files.length > 0
      ? `\n${t('scan.extra_files', { count: result.files.length })}: ${result.files.join(', ')}`
      : ''

    const contentPreview = result.content.length > 8000
      ? result.content.slice(0, 8000) + `\n\n... (${t('scan.content_truncated', { length: result.content.length })})`
      : result.content

    const nextStep = result.fromInstalled
      ? t('scan.already_installed_hint', { id: skill.id || skillId })
      : t('scan.install_hint', {
          command: source === 'local'
            ? `skill_install_local("${skillId}")`
            : `skill_market_install("${skill.id || skillId}", "${source}")`
        })

    return {
      success: true,
      output: `## ${t('scan.preview_title')}: ${skill.name || skillId}

${t('scan.source')}: ${sourceLabel} | ${t('scan.author')}: ${skill.author} | ${t('scan.version')}: ${skill.version}
${permissionsLine}${filesLine}

### ${t('scan.section_scan')}
${scanSection}

### ${t('scan.section_content')}
<skill_content_for_review>
${contentPreview}
</skill_content_for_review>

${t('scan.review_prompt')}
${nextStep}`
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `${t('scan.preview_failed')}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

// ==================== 安装安全检查辅助函数 ====================

function formatScanNote(scan: import('../../../skill-market.service').SecurityScanResult | undefined): string {
  if (!scan) return '\n' + t('scan.scan_passed')
  if (!scan.warnings.length) return '\n' + t('scan.scan_passed')
  const warningLines = scan.warnings.map(w =>
    `  - ${t(STRUCTURAL_WARN_I18N[w.type] as any, { evidence: w.evidence }) || w.description}`
  )
  return `\n${t('scan.scan_warnings', { count: scan.warnings.length })}\n${warningLines.join('\n')}`
}

function formatLowRiskNote(scan: import('../../../skill-market.service').SecurityScanResult | undefined): string {
  if (!scan || !scan.warnings.length) return ''
  return '\n\n' + t('scan.structural_hint_note', { count: scan.warnings.length })
}

function needsInstallConfirm(
  preview: import('../../../skill-market.service').SkillPreviewResult
): boolean {
  const hasExtraFiles = !!(preview.files && preview.files.length > 0)
  const hasStructuralHints = !!(preview.scan && preview.scan.warnings.length > 0)
  return hasExtraFiles || hasStructuralHints
}

/**
 * 有附属文件或结构隐蔽线索时，请用户确认（共用于 marketInstall / installLocal）。
 * 语义风险不在此硬拦——由 Agent 审阅内容后决定是否安装。
 * 返回 null 表示可继续安装，返回 ToolResult 表示被拒绝。
 */
async function confirmRiskyInstall(
  skillId: string,
  preview: import('../../../skill-market.service').SkillPreviewResult,
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult | null> {
  const fileCount = preview.files?.length || 0
  const warnCount = preview.scan?.warnings.length || 0
  log.info(`Skill ${skillId} needs confirm (files=${fileCount}, structuralHints=${warnCount})`)

  const scanNote = formatScanNote(preview.scan)
  const filesLine = fileCount > 0
    ? `\n${t('scan.evidence')}: ${preview.files!.join(', ')}`
    : ''
  const summary = fileCount > 0
    ? t('scan.market_skill_has_files', { id: skillId, count: fileCount })
    : t('scan.market_skill_has_hints', { id: skillId, count: warnCount })

  const riskLevel = 'dangerous' as const
  executor.addStep({
    type: 'tool_call',
    content: `${summary}${scanNote}${filesLine}`,
    toolName,
    toolArgs: { ...toolArgs, files: preview.files, scan_warnings: warnCount },
    riskLevel
  })

  if (!riskNeedsConfirm(riskLevel, config.executionMode, config.commandRiskPolicy)) {
    return null
  }

  const approved = await executor.waitForConfirmation(
    toolCallId, toolName,
    { ...toolArgs, files: preview.files, scan_warnings: warnCount },
    riskLevel
  )
  if (!approved) {
    log.info(`User rejected install of skill: ${skillId}`)
    executor.addStep({
      type: 'tool_result',
      content: t('scan.user_rejected', { id: skillId }),
      toolName,
      toolResult: t('scan.user_cancelled')
    })
    return { success: false, output: '', error: t('scan.user_cancelled') }
  }
  log.info(`User approved install of skill: ${skillId}`)
  return null
}

/**
 * 格式化安装完成的输出（含扫描摘要，供 AI 审阅已安装的内容）
 */
function formatInstallOutput(
  skillId: string,
  preview: import('../../../skill-market.service').SkillPreviewResult,
  hasExtraFiles: boolean | undefined,
  overwriteNote = ''
): string {
  const warningNote = formatLowRiskNote(preview.scan)
  const filesNote = hasExtraFiles && preview.files
    ? '\n\n' + t('scan.files_installed', { count: preview.files.length, files: preview.files.join(', ') })
    : ''

  const contentSummary = preview.content
    ? `\n\n<installed_skill_content>\n${preview.content.length > 3000 ? preview.content.slice(0, 3000) + '\n...' : preview.content}\n</installed_skill_content>`
    : ''

  return `${t('scan.installed_local', { id: skillId })}${overwriteNote}${warningNote}${filesNote}${contentSummary}\n\n使用 skill load "${skillId}" 加载此技能。`
}

/**
 * 从技能市场安装技能
 */
async function marketInstall(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const skillId = (args.skill_id as string)?.trim()
  const source = (args.source as SkillSource) || 'sailfish'

  if (!skillId) {
    return { success: false, output: '', error: t('scan.id_required') }
  }

  try {
    const service = getMarketService()

    // 内置预览 + 结构扫描（语义风险由 Agent 审阅，不在此硬拦）
    const preview = await service.previewSkill(skillId, source)
    if (!preview.success || !preview.content) {
      return { success: false, output: '', error: preview.error || t('scan.preview_failed') }
    }

    // 附属文件或结构隐蔽线索 → 用户确认
    const hasScripts = preview.files && preview.files.length > 0
    if (needsInstallConfirm(preview)) {
      const confirmResult = await confirmRiskyInstall(
        skillId, preview, 'skill_market_install', { skill_id: skillId, source },
        toolCallId, config, executor
      )
      if (confirmResult) return confirmResult
    }

    // 执行安装
    let installResult
    if (source === 'clawhub') {
      installResult = await service.installClawHubSkill(skillId)
    } else if (source === 'skillhub') {
      installResult = await service.installSkillHubSkill(skillId)
    } else {
      installResult = await service.installSkill(skillId)
    }
    if (!installResult.success) {
      return { success: false, output: '', error: installResult.error || t('scan.install_failed') }
    }

    const installOutput = formatInstallOutput(skillId, preview, hasScripts)

    executor.addStep({
      type: 'tool_result',
      content: t('scan.installed_market', { id: skillId }),
      toolName: 'skill_market_install',
      toolResult: installOutput
    })

    return { success: true, output: installOutput }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `${t('scan.install_failed')}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 从本地路径安装技能（ZIP、目录或独立 .md）
 */
async function installLocal(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const sourcePath = (args.source_path as string)?.trim()
  if (!sourcePath) {
    return { success: false, output: '', error: t('scan.id_required') }
  }

  let skillId = (args.skill_id as string)?.trim().toLowerCase()

  try {
    const service = getMarketService()

    // 内置预览 + 结构扫描（语义风险由 Agent 审阅，不在此硬拦）
    const preview = service.previewLocalSkill(sourcePath)
    if (!preview.success || !preview.content || !preview.filesMap) {
      return { success: false, output: '', error: preview.error || t('scan.preview_failed') }
    }

    if (!skillId) {
      skillId = preview.skill?.id || path.basename(sourcePath, '.zip')
    }
    skillId = skillId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (!skillId) {
      return { success: false, output: '', error: t('scan.id_required') }
    }

    log.info(`Local skill install: ${skillId} from ${sourcePath}`)

    // 附属文件或结构隐蔽线索 → 用户确认
    const hasExtraFiles = preview.files && preview.files.length > 0
    if (needsInstallConfirm(preview)) {
      const confirmResult = await confirmRiskyInstall(
        skillId, preview, 'skill_install_local',
        { skill_id: skillId, source_path: sourcePath },
        toolCallId, config, executor
      )
      if (confirmResult) return confirmResult
    }

    // 执行安装
    const result = service.installLocalSkillFiles(skillId, preview.filesMap)
    if (!result.success) {
      return { success: false, output: '', error: result.error || t('scan.install_failed') }
    }

    const overwriteNote = result.overwritten ? t('scan.overwritten') : ''
    const installOutput = formatInstallOutput(skillId, preview, hasExtraFiles, overwriteNote)

    executor.addStep({
      type: 'tool_result',
      content: `${t('scan.installed_local', { id: skillId })}${overwriteNote}`,
      toolName: 'skill_install_local',
      toolResult: installOutput
    })

    return { success: true, output: installOutput }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: `${t('scan.install_failed')}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
