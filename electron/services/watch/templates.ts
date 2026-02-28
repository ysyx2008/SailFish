/**
 * Watch 模板 - 内置常用 Watch 预设
 *
 * 模板提供预配置的 Watch 定义，用户只需微调即可使用。
 * 每个模板包含一个工厂函数，生成 CreateWatchParams。
 */
import type { CreateWatchParams } from './types'

export interface WatchTemplate {
  id: string
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  category: 'daily' | 'monitor' | 'email' | 'devops' | 'custom'
  icon: string
  create: (options?: Record<string, unknown>) => CreateWatchParams
}

export const watchTemplates: WatchTemplate[] = [
  // ==================== 日常效率 ====================
  {
    id: 'morning-briefing',
    name: '每日晨间简报',
    nameEn: 'Morning Briefing',
    description: '每天早上推送天气、日程、重要邮件和新闻摘要',
    descriptionEn: 'Daily morning push: weather, schedule, important emails, news summary',
    category: 'daily',
    icon: '☀️',
    create: (options) => ({
      name: '每日晨间简报',
      description: '每天早上推送天气、日程、重要邮件和新闻摘要',
      triggers: [{ type: 'cron', expression: options?.cron as string || '0 8 * * *' }],
      prompt: `你是我的个人助手。请为我生成今日晨间简报，包括：
1. 当前天气和今日天气预报
2. 今日日程安排
3. 重要的未读邮件摘要（如果有的话）
4. 科技新闻简要

请用简洁友好的语气，像朋友聊天一样。如果今天是周末，可以更轻松一些。`,
      skills: ['email', 'browser'],
      execution: { type: 'local' },
      output: { type: options?.output as any || 'im' },
      priority: 'normal'
    })
  },

  {
    id: 'calendar-reminder',
    name: '日历事件提醒',
    nameEn: 'Calendar Event Reminder',
    description: '在日历事件开始前提醒，并提供相关上下文',
    descriptionEn: 'Remind before calendar events with relevant context',
    category: 'daily',
    icon: '📅',
    create: (options) => ({
      name: '日历事件提醒',
      description: '在日历事件开始前提醒，并提供相关上下文',
      triggers: [{
        type: 'calendar',
        beforeMinutes: (options?.beforeMinutes as number) || 15,
        icsPath: options?.icsPath as string
      }],
      prompt: `日历事件即将开始。请根据事件信息：
1. 提醒我事件的时间和地点
2. 如果是会议，帮我准备可能需要的上下文
3. 如果需要出行，估算通勤时间

保持简洁，只提供有用的信息。`,
      execution: { type: 'local' },
      output: { type: 'notification' },
      priority: 'high'
    })
  },

  // ==================== 邮件处理 ====================
  {
    id: 'email-auto-reply',
    name: '邮件智能分类',
    nameEn: 'Smart Email Triage',
    description: '收到新邮件时自动分类和摘要，重要邮件立即通知',
    descriptionEn: 'Auto-classify and summarize new emails, instant notify for important ones',
    category: 'email',
    icon: '📧',
    create: (options) => ({
      name: '邮件智能分类',
      description: '收到新邮件时自动分类和摘要，重要邮件立即通知',
      triggers: [{
        type: 'email',
        filter: {
          unseen: true,
          from: options?.fromFilter as string,
          subject: options?.subjectFilter as string
        }
      }],
      prompt: `收到一封新邮件。请：
1. 判断邮件的紧急程度（紧急/普通/低优先级）
2. 生成一句话摘要
3. 如果需要回复，建议回复要点
4. 如果是垃圾邮件或营销邮件，标记为低优先级

完成后用 watch_state_update 工具将摘要和紧急程度保存到当前关切的状态中。`,
      skills: ['email'],
      execution: { type: 'local' },
      output: { type: 'notification' },
      priority: 'normal'
    })
  },

  // ==================== 开发运维 ====================
  {
    id: 'log-monitor',
    name: '日志文件监控',
    nameEn: 'Log File Monitor',
    description: '监控日志文件变化，发现错误或异常时告警',
    descriptionEn: 'Monitor log file changes, alert on errors or anomalies',
    category: 'devops',
    icon: '📋',
    create: (options) => ({
      name: '日志文件监控',
      description: '监控日志文件变化，发现错误或异常时告警',
      triggers: [{
        type: 'file_change',
        paths: (options?.paths as string[]) || ['/var/log/syslog'],
        pattern: options?.pattern as string || '*.log',
        events: ['change']
      }],
      prompt: `日志文件发生变化。请：
1. 读取文件最近的内容（最后 50 行）
2. 检查是否有 ERROR、FATAL、Exception 等异常
3. 如果有异常，分析可能的原因
4. 生成简明的监控报告

只在发现问题时通知我，正常变化不需要报告。`,
      execution: { type: 'local' },
      output: { type: 'notification' },
      priority: 'high'
    })
  },

  {
    id: 'deploy-webhook',
    name: 'Webhook 部署通知',
    nameEn: 'Webhook Deploy Notification',
    description: '接收 CI/CD Webhook，自动验证部署并通知结果',
    descriptionEn: 'Receive CI/CD webhooks, auto-verify deployment and notify',
    category: 'devops',
    icon: '🚀',
    create: () => ({
      name: 'Webhook 部署通知',
      description: '接收 CI/CD Webhook，自动验证部署并通知结果',
      triggers: [{ type: 'webhook', token: '' }],
      prompt: `收到了部署 Webhook 通知。请根据 Webhook payload：
1. 确认部署状态（成功/失败）
2. 如果部署成功，运行基本的健康检查（如 curl 服务端点）
3. 生成部署报告摘要
4. 如果失败，分析可能的原因

完成后用 watch_state_update 工具将部署时间、状态、版本号保存到 watch_state。`,
      execution: { type: 'local' },
      output: { type: 'im' },
      priority: 'high'
    })
  },

  {
    id: 'server-heartbeat',
    name: '服务器定期巡检',
    nameEn: 'Server Health Check',
    description: '定期检查服务器状态，包括 CPU、内存、磁盘等',
    descriptionEn: 'Periodically check server status: CPU, memory, disk',
    category: 'devops',
    icon: '🖥️',
    create: (options) => ({
      name: '服务器定期巡检',
      description: '定期检查服务器状态，包括 CPU、内存、磁盘等',
      triggers: [{ type: 'heartbeat' }],
      prompt: `请对当前服务器执行健康检查：
1. CPU 使用率（top 或 uptime）
2. 内存使用情况（free -h）
3. 磁盘使用率（df -h）
4. 关键服务状态
5. 最近的系统错误日志

只有在发现异常时才生成完整报告。
完成后用 watch_state_update 工具将 CPU、内存、磁盘使用率和检查时间保存到 watch_state。`,
      execution: options?.sshSessionId
        ? { type: 'ssh', sshSessionId: options.sshSessionId as string }
        : { type: 'local' },
      output: { type: 'notification' },
      priority: 'normal'
    })
  },

  // ==================== 监控类 ====================
  {
    id: 'file-change-notifier',
    name: '文件变更通知',
    nameEn: 'File Change Notifier',
    description: '监控指定目录的文件变更并通知',
    descriptionEn: 'Monitor file changes in specified directory and notify',
    category: 'monitor',
    icon: '📁',
    create: (options) => ({
      name: '文件变更通知',
      description: '监控指定目录的文件变更并通知',
      triggers: [{
        type: 'file_change',
        paths: (options?.paths as string[]) || ['.'],
        pattern: options?.pattern as string,
        events: (options?.events as Array<'add' | 'change' | 'unlink'>) || ['add', 'change', 'unlink']
      }],
      prompt: `指定目录的文件发生了变化。请：
1. 描述发生了什么变化
2. 如果是代码文件，简要分析改动的影响
3. 通知我变更内容`,
      execution: { type: 'local' },
      output: { type: 'notification' },
      priority: 'normal'
    })
  },

  {
    id: 'deadline-reminder',
    name: '待办截止提醒',
    nameEn: 'Deadline Reminder',
    description: '每天检查待办事项，提醒临近截止日期的任务',
    descriptionEn: 'Daily check on TODO items, remind about approaching deadlines',
    category: 'daily',
    icon: '⏰',
    create: (options) => ({
      name: '待办截止提醒',
      description: '每天检查待办事项，提醒临近截止日期的任务',
      triggers: [{ type: 'cron', expression: options?.cron as string || '0 9 * * *' }],
      prompt: `请检查你的私有工作空间中的 TODO.md 文件，查看用户的待办事项：
1. 读取 TODO.md 文件
2. 找出已逾期或 3 天内即将到期的任务
3. 如果有紧急待办，通过 talk_to_user 提醒用户，语气自然友好
4. 如果所有待办都不紧急，直接结束，不要打扰用户
5. 如果 TODO.md 不存在或为空，直接结束`,
      execution: { type: 'local' },
      output: { type: options?.output as any || 'desktop' },
      priority: 'normal'
    })
  },

  {
    id: 'periodic-summary',
    name: '定期工作总结',
    nameEn: 'Periodic Work Summary',
    description: '基于心跳定期生成工作总结和待办提醒',
    descriptionEn: 'Periodic work summary and todo reminders based on heartbeat',
    category: 'daily',
    icon: '📝',
    create: () => ({
      name: '定期工作总结',
      description: '基于心跳定期生成工作总结和待办提醒',
      triggers: [{ type: 'heartbeat' }],
      prompt: `请帮我回顾当前状态：
1. 查看最近的命令历史和工作目录
2. 总结我最近在做什么
3. 提醒可能遗忘的待办事项
4. 建议接下来可以做什么

如果我似乎不在工作（比如长时间没有命令执行），则不要打扰。
保持简洁友好。`,
      execution: { type: 'local' },
      output: { type: 'notification' },
      priority: 'low'
    })
  }
]

export function getTemplateById(id: string): WatchTemplate | undefined {
  return watchTemplates.find(t => t.id === id)
}

export function getTemplatesByCategory(category: WatchTemplate['category']): WatchTemplate[] {
  return watchTemplates.filter(t => t.category === category)
}

export function getAllTemplateCategories(): Array<{ id: string; name: string; nameEn: string }> {
  return [
    { id: 'daily', name: '日常效率', nameEn: 'Daily Productivity' },
    { id: 'email', name: '邮件处理', nameEn: 'Email Management' },
    { id: 'devops', name: '开发运维', nameEn: 'DevOps' },
    { id: 'monitor', name: '监控告警', nameEn: 'Monitoring' },
    { id: 'custom', name: '自定义', nameEn: 'Custom' }
  ]
}
