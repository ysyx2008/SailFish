/**
 * shell 路径反斜杠转义 → 工作区分区正确识别
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return '/Users/yushen/Library/Application Support/SailFish'
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import * as os from 'os'
import * as path from 'path'
import { unescapeShellWordLiteral } from '../unescape-shell-literal'
import { extractAuditedCalls } from '../extract-calls'
import { getWorkspaceZone, isLexicallyAbsolutePath, resolveCommandPath } from '../workspace-guard'
import { assessShellRisk, defaultAuditContext } from '../assess-shell'
import { commandNeedsConfirm } from '../confirm-policy'

describe('unescapeShellWordLiteral', () => {
  it('解开 Application\\ Support', () => {
    expect(unescapeShellWordLiteral(String.raw`/Users/me/Library/Application\ Support/x`))
      .toBe('/Users/me/Library/Application Support/x')
  })

  it('保留 Windows 盘符路径', () => {
    expect(unescapeShellWordLiteral(String.raw`C:\Users\me\file`)).toBe(String.raw`C:\Users\me\file`)
  })
})

describe('scratch 路径含空格（Application Support）', () => {
  const real =
    '/Users/yushen/Library/Application Support/SailFish/agent-workspace/scratch/fireworks-tech-graph'

  it('extract 后路径无残留反斜杠，zone=free，rm 可自动执行', async () => {
    const cmd = String.raw`rm -rf /Users/yushen/Library/Application\ Support/SailFish/agent-workspace/scratch/fireworks-tech-graph`
    const ctx = defaultAuditContext()
    const { calls } = await extractAuditedCalls(cmd, ctx)
    expect(calls[0]?.paths[0]).toBe(real)
    expect(getWorkspaceZone(calls[0].paths[0], ctx.cwd)).toBe('free')

    const assessment = await assessShellRisk(cmd, ctx)
    expect(assessment.level).toBe('safe')
    expect(assessment.calls.flatMap(c => c.reasons).join('')).not.toContain('工作区外')
  })
})

describe('resolveCommandPath 展开 ~', () => {
  it('~/path 展开为 homedir，不落在 scratch 下', () => {
    const scratch = path.join(
      '/Users/yushen/Library/Application Support/SailFish/agent-workspace/scratch',
    )
    const resolved = resolveCommandPath('~/Desktop/rm_test_outside.txt', scratch)
    expect(resolved).toBe(path.join(os.homedir(), 'Desktop', 'rm_test_outside.txt'))
    expect(resolved.startsWith(scratch)).toBe(false)
    expect(getWorkspaceZone('~/Desktop/rm_test_outside.txt', scratch)).toBe('outside')
  })

  it('scratch cwd 下 rm ~/Desktop/... 仍为 dangerous（宽松模式需确认）', async () => {
    const ctx = defaultAuditContext()
    const assessment = await assessShellRisk('rm ~/Desktop/rm_test_outside.txt', ctx)
    expect(assessment.level).toBe('dangerous')
    expect(assessment.calls[0]?.pathZones).toEqual(['outside'])
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(true)
  })
})

describe('isLexicallyAbsolutePath', () => {
  it('识别 /…、~/…、~、相对路径与空串', () => {
    expect(isLexicallyAbsolutePath('/tmp/x')).toBe(true)
    expect(isLexicallyAbsolutePath('~/Desktop/x')).toBe(true)
    expect(isLexicallyAbsolutePath('~')).toBe(true)
    expect(isLexicallyAbsolutePath('draft.txt')).toBe(false)
    expect(isLexicallyAbsolutePath('./draft.txt')).toBe(false)
    expect(isLexicallyAbsolutePath('')).toBe(false)
    expect(isLexicallyAbsolutePath('~user/foo')).toBe(false)
  })
})

describe('自由区降级只认词法绝对路径', () => {
  it('cd Desktop && rm 相对路径：宽松模式需确认（按 cd 定下的桌面算，不按 scratch cwd 误判 free）', async () => {
    const ctx = defaultAuditContext()
    const assessment = await assessShellRisk(
      'cd /Users/yushen/Desktop && rm rm_test_relative.txt',
      ctx,
    )
    expect(assessment.level).toBe('dangerous')
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(true)
    const rm = assessment.calls.find(c => c.cmd === 'rm')
    expect(rm?.pathZones).toEqual(['outside'])
    // 位置已由 cd 确定（就是桌面），原因只剩命令本身高危，不再说「相对路径」
    expect(rm?.reasons.some(r => r.includes('高危命令') || r.includes('High-risk'))).toBe(true)
  })

  it('cd 目录写成变量：位置确定不了，仍按相对路径不降级', async () => {
    const ctx = defaultAuditContext()
    const assessment = await assessShellRisk('cd "$HOME/Desktop" && rm rm_test_relative.txt', ctx)
    expect(assessment.level).toBe('dangerous')
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(true)
    const rm = assessment.calls.find(c => c.cmd === 'rm')
    expect(rm?.reasons.some(r => r.includes('相对路径') || r.includes('relative path'))).toBe(true)
  })

  it('scratch cwd 下相对路径 rm 仍 dangerous（宽松需确认）', async () => {
    const ctx = defaultAuditContext()
    const assessment = await assessShellRisk('rm draft.txt', ctx)
    expect(assessment.level).toBe('dangerous')
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(true)
  })

  it('绝对路径 rm scratch 文件仍可降为 safe', async () => {
    const ctx = defaultAuditContext()
    const abs = path.join(ctx.cwd!, 'draft.txt')
    const assessment = await assessShellRisk(`rm -f "${abs}"`, ctx)
    expect(assessment.level).toBe('safe')
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(false)
  })

  it('混有相对路径时整体仍 dangerous（即便另一目标在 free 绝对路径）', async () => {
    const ctx = defaultAuditContext()
    const abs = path.join(ctx.cwd!, 'a.txt')
    const assessment = await assessShellRisk(`rm -f "${abs}" ./b.txt`, ctx)
    expect(assessment.level).toBe('dangerous')
    expect(commandNeedsConfirm(assessment, 'relaxed')).toBe(true)
  })
})
