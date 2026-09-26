vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../user-skill.service', () => ({
  getUserSkillService: () => ({ getEnabledSkills: () => [] })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  getApiKey: () => '',
}))

import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'
import { getAgentTools, filterSubAgentTools } from '../tools'
import { getSubAgentTools, toSubAgentContext, denyIfParentOnly } from '../tools/sub-agent'
import type { AgentContext } from '../types'
import type { ToolExecutorConfig } from '../tools/types'
import { getLocalOS } from '../../../utils/platform'
import { emailTools } from '../skills/email/tools'
import { calendarTools } from '../skills/calendar/tools'
import { watchTools } from '../skills/watch/tools'

describe('伙计工具面', () => {
  it('清单含读写和 exec，不含提问/派遣/发信/关切', () => {
    const names = getSubAgentTools().map(t => t.function.name)
    expect(names).toContain('exec')
    expect(names).toContain('read_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('write_text_file')
    expect(names).toContain('skill')
    expect(names).not.toContain('ask_user')
    expect(names).not.toContain('talk_to_user')
    expect(names).not.toContain('plan')
    expect(names).not.toContain('dispatch_agents')
    expect(names).not.toContain('followup_agent')
    expect(names).not.toContain('wait_agents')
    expect(names).not.toContain('interrupt_agent')
    expect(names).not.toContain('manage_pane')
    expect(names).not.toContain('send_to_chat')
    expect(names).not.toContain('context')
    expect(names).not.toContain('recall_compressed')
  })

  it('伙计看到的 exec 说明是拦住，不是确认或自由放行', () => {
    const child = filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant' }))
    const exec = child.find(t => t.function.name === 'exec')
    expect(exec?.function.description).toContain('一律拦住')
    expect(exec?.function.description).toContain('不会问人签字')
    expect(exec?.function.description).not.toContain('free 放行')
    expect(exec?.function.description).not.toContain('需确认')
  })

  it('过滤只认元数据，不认工具名', () => {
    const parent = getAgentTools(undefined, { mode: 'assistant' })
    const child = filterSubAgentTools(parent)
    expect(child.every(t => (t as { _meta?: { allowedForSubAgent?: boolean } })._meta?.allowedForSubAgent !== false)).toBe(true)
  })

  it('发信和改日程标成伙计不能用', () => {
    expect(emailTools.find(t => t.function.name === 'email_send')).toMatchObject({ _meta: { allowedForSubAgent: false } })
    expect(calendarTools.find(t => t.function.name === 'calendar_create')).toMatchObject({ _meta: { allowedForSubAgent: false } })
    expect(watchTools.every(t => (t as { _meta?: { allowedForSubAgent?: boolean } })._meta?.allowedForSubAgent === false)).toBe(true)
  })

  it('伙计不碰终端窗，也不动产出物面板', () => {
    const names = getSubAgentTools().map(t => t.function.name)
    for (const name of [
      'execute_command', 'check_terminal_status', 'get_terminal_context', 'send_control_key', 'send_input',
      'list_workbench_artifacts', 'manage_workbench_artifacts',
    ]) {
      expect(names).not.toContain(name)
    }
    expect(names).toContain('exec')
    expect(names).toContain('await_exec')
  })

  it('运行时也拦：伙计硬调终端工具被拒，主人不受影响', () => {
    const catalog = getAgentTools(undefined, { mode: 'local' })
    const asChild = { isSubAgent: true, getToolCatalog: () => catalog } as unknown as ToolExecutorConfig
    const asParent = { isSubAgent: false, getToolCatalog: () => catalog } as unknown as ToolExecutorConfig
    expect(denyIfParentOnly(asChild, 'execute_command')?.success).toBe(false)
    expect(denyIfParentOnly(asChild, 'send_control_key')?.success).toBe(false)
    expect(denyIfParentOnly(asChild, 'read_file')).toBeNull()
    expect(denyIfParentOnly(asParent, 'execute_command')).toBeNull()
  })

  it('主人自己的终端工具不受影响', () => {
    const names = getAgentTools(undefined, { mode: 'local' }).map(t => t.function.name)
    expect(names).toContain('execute_command')
    expect(names).toContain('send_input')
  })
})

describe('伙计的运行上下文', () => {
  const base: AgentContext = {
    terminalOutput: ['$ ls', 'a b'],
    systemInfo: { os: 'linux', shell: 'bash' },
    terminalType: 'local',
    cwd: '/Users/me/project',
    hostId: 'local',
    ptyId: 'pty-1',
    mode: 'split',
    panes: [],
    activePaneId: 'p1',
    workbenchPrompt: '产出物面板说明',
    sessionId: 's-1',
  }
  const localOs = getLocalOS()

  it('本地终端页派出：没有窗，沿用主人的本机目录', () => {
    const ctx = toSubAgentContext(base)
    expect(ctx.terminalType).toBe('assistant')
    expect(ctx.ptyId).toBeUndefined()
    expect(ctx.panes).toBeUndefined()
    expect(ctx.activePaneId).toBeUndefined()
    expect(ctx.mode).toBeUndefined()
    expect(ctx.workbenchPrompt).toBeUndefined()
    expect(ctx.terminalOutput).toEqual([])
    expect(ctx.cwd).toBe('/Users/me/project')
    expect(ctx.unattended).toBe(true)
    expect(ctx.sessionId).toBe('s-1')
  })

  it('助手眼前坐着远程窗：系统、主机都换回本机，本机目录照旧', () => {
    const ctx = toSubAgentContext({
      ...base,
      terminalType: 'assistant',
      cwd: '/Users/me/watch-dir',
      hostId: 'ssh-10.0.2.100',
      sshHost: '10.0.2.100',
      systemInfo: { os: 'linux', shell: 'bash' },
    })
    expect(ctx.hostId).toBe('local')
    expect(ctx.sshHost).toBeUndefined()
    expect(ctx.systemInfo.os).toBe(localOs)
    expect(ctx.cwd).toBe('/Users/me/watch-dir')
  })

  it('远程形态的目录不带过去', () => {
    const ctx = toSubAgentContext({ ...base, terminalType: 'ssh', cwd: '/var/www' })
    expect(ctx.cwd).toBe(os.homedir())
  })

  it('按伙计上下文推出的工具形态有本机命令、没有终端窗', () => {
    const ctx = toSubAgentContext(base)
    const names = filterSubAgentTools(getAgentTools(undefined, { mode: ctx.terminalType })).map(t => t.function.name)
    expect(names).toContain('exec')
    expect(names).not.toContain('execute_command')
    expect(names).not.toContain('sftp_put')
  })
})
