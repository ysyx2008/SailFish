/**
 * 本机文件工具的路径解析：相对路径只认本机目录，不拿远程 cwd 往本机上拼。
 */
import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'

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

import fs from 'fs'
import { resolveLocalFilePath, announcedLocalCwd } from '../tools/file'
import type { AgentContext } from '../types'
import { getAgentTools, type ToolDefinitionWithMeta } from '../tools'

describe('resolveLocalFilePath', () => {
  it('绝对路径原样返回', () => {
    const abs = path.join(os.homedir(), 'doc.md')
    expect(resolveLocalFilePath(abs, { type: 'ssh', cwd: '/var/www' })).toBe(abs)
  })

  it('~ 展开为本机主目录', () => {
    expect(resolveLocalFilePath('~/notes.md', { type: 'ssh', cwd: '/home/ubuntu' }))
      .toBe(path.join(os.homedir(), 'notes.md'))
  })

  it('本机终端：相对路径跟该终端当前目录走', () => {
    const localCwd = path.join(os.tmpdir(), 'sailfish-local-cwd')
    expect(resolveLocalFilePath('notes.md', { type: 'local', cwd: localCwd }))
      .toBe(path.join(localCwd, 'notes.md'))
  })

  it('远程窗格：相对路径落到本机主目录，不跟远程目录拼', () => {
    expect(resolveLocalFilePath('notes.md', { type: 'ssh', cwd: '/home/ubuntu/app' }))
      .toBe(path.join(os.homedir(), 'notes.md'))
    expect(resolveLocalFilePath('notes.md', { type: 'ssh', cwd: '/home/ubuntu/app' }))
      .not.toBe(path.join('/home/ubuntu/app', 'notes.md'))
  })

  it('没有本机终端时相对路径落到本机主目录', () => {
    expect(resolveLocalFilePath('notes.md', null)).toBe(path.join(os.homedir(), 'notes.md'))
    expect(resolveLocalFilePath('notes.md', undefined)).toBe(path.join(os.homedir(), 'notes.md'))
  })

  it('没有本机终端但助手宣称了默认目录：跟宣称的目录走', () => {
    const announced = path.join(os.tmpdir(), 'sailfish-announced')
    expect(resolveLocalFilePath('notes.md', null, announced)).toBe(path.join(announced, 'notes.md'))
    expect(resolveLocalFilePath('notes.md', { type: 'ssh', cwd: '/home/ubuntu' }, announced))
      .toBe(path.join(announced, 'notes.md'))
  })

  it('本机终端的当前目录优先于宣称的目录', () => {
    const localCwd = path.join(os.tmpdir(), 'sailfish-local-cwd')
    expect(resolveLocalFilePath('notes.md', { type: 'local', cwd: localCwd }, os.homedir()))
      .toBe(path.join(localCwd, 'notes.md'))
  })
})

describe('announcedLocalCwd', () => {
  const ctx = (patch: Partial<AgentContext>): AgentContext => ({
    terminalOutput: [],
    systemInfo: { os: 'macos', shell: 'zsh' },
    terminalType: 'assistant',
    ...patch,
  })

  it('助手形态、目录存在：就是它', () => {
    const dir = fs.realpathSync(os.tmpdir())
    expect(announcedLocalCwd(ctx({ cwd: dir }))).toBe(dir)
  })

  it('本地终端页报的是眼前窗的本机目录，算数', () => {
    const dir = fs.realpathSync(os.tmpdir())
    expect(announcedLocalCwd(ctx({ terminalType: 'local', cwd: dir }))).toBe(dir)
  })

  it('远程终端页报的是远端目录，不当成本机目录', () => {
    const dir = fs.realpathSync(os.tmpdir())
    expect(announcedLocalCwd(ctx({ terminalType: 'ssh', cwd: dir }))).toBeUndefined()
  })

  it('不存在、是文件、或不是绝对路径都不算', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-announced-')), 'f.txt')
    fs.writeFileSync(file, 'x')
    expect(announcedLocalCwd(ctx({ cwd: path.join(os.tmpdir(), 'no-such-dir-sailfish') }))).toBeUndefined()
    expect(announcedLocalCwd(ctx({ cwd: file }))).toBeUndefined()
    expect(announcedLocalCwd(ctx({ cwd: 'relative/dir' }))).toBeUndefined()
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

describe('SSH 模式本机能力可见', () => {
  it('远程会话能看到本机读写和本机命令，并保留远程写入', () => {
    const names = getAgentTools(undefined, { mode: 'ssh' }).map(t => t.function.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_text_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('file_search')
    expect(names).toContain('write_remote_text_file')
    expect(names).toContain('exec')
    expect(names).toContain('await_exec')
    expect(names).not.toContain('dispatch_agents')
  })

  it('本机读写和本机命令的可见性由元数据声明', () => {
    const ssh = getAgentTools(undefined, { mode: 'ssh' }) as ToolDefinitionWithMeta[]
    const local = getAgentTools(undefined, { mode: 'local' }) as ToolDefinitionWithMeta[]
    const metaOf = (tools: ToolDefinitionWithMeta[], name: string) =>
      tools.find(t => t.function.name === name)?._meta

    expect(metaOf(ssh, 'read_file')?.supportedModes).toEqual(['local', 'assistant', 'ssh'])
    expect(metaOf(ssh, 'file_search')?.supportedModes).toEqual(['local', 'assistant', 'ssh'])
    expect(metaOf(ssh, 'edit_file')?.supportedModes).toEqual(['local', 'assistant', 'ssh'])
    expect(metaOf(ssh, 'write_text_file')?.supportedModes).toEqual(['local', 'assistant', 'ssh'])
    expect(metaOf(ssh, 'exec')?.supportedModes).toEqual(['assistant', 'ssh'])
    expect(metaOf(ssh, 'await_exec')?.supportedModes).toEqual(['assistant', 'ssh'])

    expect(local.map(t => t.function.name)).not.toContain('exec')
    expect(local.map(t => t.function.name)).not.toContain('await_exec')
  })
})
