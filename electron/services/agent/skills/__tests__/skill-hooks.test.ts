import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { registerSkill } from '../registry'
import { createSkillSession } from '../skill-loader'
import { resolveLocalFilePath } from '../../tools/file'
import type { ToolResult } from '../../tools/types'

const order: string[] = []

describe('技能钩子', () => {
  beforeAll(() => {
    registerSkill({
      id: 'hook-outer',
      name: 'outer',
      description: '',
      tools: [],
      workingDirectory: data => data.root as string | undefined,
      inheritToSubAgents: true,
      async onRunStart(ctx) {
        ctx.data.runs = ((ctx.data.runs as number) ?? 0) + 1
        ctx.data.lastIsSubAgent = ctx.isSubAgent
      },
      async wrapToolCall(call, proceed) {
        order.push(`outer:before:${call.name}`)
        const result = await proceed()
        order.push('outer:after')
        return { ...result, output: `${result.output}+outer` }
      },
    })
    registerSkill({
      id: 'hook-inner',
      name: 'inner',
      description: '',
      tools: [],
      async onRunStart() { throw new Error('boom') },
      async wrapToolCall(_call, proceed, ctx) {
        order.push(`inner:${ctx.resolveLocalPath('a.txt')}`)
        return proceed()
      },
    })
  })

  it('没装技能时工作目录为空、工具原样执行', async () => {
    const session = createSkillSession([])
    expect(session.getWorkingDirectory()).toBeUndefined()
    const result = await session.runToolCall(
      { name: 'x', args: {} },
      async () => ({ success: true, output: 'raw' }),
      p => p,
    )
    expect(result.output).toBe('raw')
  })

  it('工作目录来自装着的技能', async () => {
    const session = createSkillSession([])
    await session.loadSkill('hook-outer')
    expect(session.getWorkingDirectory()).toBeUndefined()
    session.setSkillData('hook-outer', { root: '/proj' })
    expect(session.getWorkingDirectory()).toBe('/proj')
  })

  it('先装的包在最外层，前后都能插手', async () => {
    order.length = 0
    const session = createSkillSession([])
    await session.loadSkill('hook-outer')
    await session.loadSkill('hook-inner')
    const execute = vi.fn(async (): Promise<ToolResult> => {
      order.push('execute')
      return { success: true, output: 'raw' }
    })
    const result = await session.runToolCall({ name: 'edit_file', args: {} }, execute, p => `/abs/${p}`)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['outer:before:edit_file', 'inner:/abs/a.txt', 'execute', 'outer:after'])
    expect(result.output).toBe('raw+outer')
  })

  it('包装层出错不连累工具：放行前出错就跳过这层，放行后出错用里层结果，工具只执行一次', async () => {
    registerSkill({
      id: 'hook-throw-before',
      name: 'throw-before',
      description: '',
      tools: [],
      async wrapToolCall() { throw new Error('before') },
    })
    registerSkill({
      id: 'hook-throw-after',
      name: 'throw-after',
      description: '',
      tools: [],
      async wrapToolCall(_call, proceed) {
        await proceed()
        throw new Error('after')
      },
    })
    const session = createSkillSession([])
    await session.loadSkill('hook-throw-before')
    await session.loadSkill('hook-throw-after')
    const execute = vi.fn(async (): Promise<ToolResult> => ({ success: true, output: 'raw' }))
    const result = await session.runToolCall({ name: 'x', args: {} }, execute, p => p)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.output).toBe('raw')
  })

  it('伙计改了嵌套的状态也不回写主人', async () => {
    const parent = createSkillSession([])
    await parent.loadSkill('hook-outer')
    parent.setSkillData('hook-outer', { ids: ['a'] })
    const [{ data }] = parent.getInheritableSkills()
    ;(data.ids as string[]).push('b')
    expect(parent.getSkillData<{ ids: string[] }>('hook-outer')?.ids).toEqual(['a'])
  })

  it('每轮开始通知所有装着的技能，一份出错不影响别的', async () => {
    const session = createSkillSession([])
    await session.loadSkill('hook-inner')
    await session.loadSkill('hook-outer')
    await session.notifyRunStart({ isSubAgent: true })
    await session.notifyRunStart({ isSubAgent: false })
    const inheritable = session.getInheritableSkills()
    expect(inheritable).toEqual([{ skillId: 'hook-outer', data: { runs: 2, lastIsSubAgent: false } }])
  })

  it('带给伙计的状态是拷贝，伙计改了不回写主人', async () => {
    const parent = createSkillSession([])
    await parent.loadSkill('hook-outer')
    parent.setSkillData('hook-outer', { root: '/proj' })
    const [{ data }] = parent.getInheritableSkills()
    data.root = '/elsewhere'
    expect(parent.getWorkingDirectory()).toBe('/proj')
  })
})

describe('本机相对路径基准', () => {
  it('给了工作目录就按工作目录，否则仍按本机终端目录 / 主目录', () => {
    const proj = path.join(os.tmpdir(), 'proj')
    expect(resolveLocalFilePath('src/a.ts', { type: 'local', cwd: '/other' }, undefined, proj)).toBe(path.join(proj, 'src/a.ts'))
    expect(resolveLocalFilePath('src/a.ts', null, os.homedir(), proj)).toBe(path.join(proj, 'src/a.ts'))
    expect(resolveLocalFilePath('src/a.ts', { type: 'local', cwd: proj })).toBe(path.join(proj, 'src/a.ts'))
    expect(resolveLocalFilePath('src/a.ts', null)).toBe(path.join(os.homedir(), 'src/a.ts'))
    expect(resolveLocalFilePath('/abs/a.ts', null, undefined, proj)).toBe('/abs/a.ts')
  })
})
