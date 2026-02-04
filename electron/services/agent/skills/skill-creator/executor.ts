/**
 * 用户技能创建执行器
 */
import * as fs from 'fs'
import * as path from 'path'
import { getUserSkillService } from '../../../user-skill.service'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'

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

    // 添加执行步骤
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
调用 \`load_user_skill("${skillId}")\` 加载此技能。`
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
