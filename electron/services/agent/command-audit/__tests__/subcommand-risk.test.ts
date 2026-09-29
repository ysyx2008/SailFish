/**
 * git 按子命令升级风险：会丢活的定高危，日常操作不受影响
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-subcommand-risk-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs } from '../../tools/file'
import { assessCommandRisk, assessCommandRiskDetailed } from '../../risk-assessor'
import { assessSubcommandRisk } from '../subcommand-risk'
import type { AuditedCall } from '../types'

describe('git 子命令风险', () => {
  beforeAll(async () => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    const { ensureShellAstReady } = await import('../parser')
    await ensureShellAstReady()
  })

  afterAll(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it.each([
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git -C /repo reset --hard',
    'git checkout -- .',
    'git checkout -- src/a.ts',
    'git checkout .',
    'git checkout HEAD src/a.ts',
    'git checkout -f main',
    'git restore src/a.ts',
    'git restore --staged --worktree src/a.ts',
    'git switch -f main',
    'git switch --discard-changes main',
    'git clean -fdx',
    'git clean --force',
    'git stash drop',
    'git -c core.x=y stash drop stash@{0}',
    'git stash clear',
    'git branch -D feat',
    'git branch --delete --force feat',
    'git push --force',
    'git push -f origin main',
    'git push --force-with-lease=main origin',
    'git push origin --delete old',
    'git push --mirror backup',
    'git push --prune origin',
    'git push origin +main',
    'git push origin :old',
    'cd /repo && git reset --hard',
    'git reset --hard > /dev/null',
    'git clean -fdx 2>/dev/null',
    'git checkout -- "$F"',
    'git checkout -B main origin/main',
    'git branch -f main HEAD~3',
    'git reflog expire --expire=now --all',
    'git reflog delete HEAD@{1}',
    'dd if=/dev/zero of=/tmp/x > /dev/null',
  ])('%s → dangerous', async cmd => {
    expect(await assessCommandRisk(cmd)).toBe('dangerous')
  })

  it.each([
    ['git status', 'safe'],
    ['git diff', 'safe'],
    ['git push', 'safe'],
    ['git push origin main', 'safe'],
    ['git add .', 'safe'],
    ['git checkout main', 'safe'],
    ['git stash', 'safe'],
    ['git stash pop', 'safe'],
    ['git branch feat', 'safe'],
    ['git reset HEAD~1', 'safe'],
    ['git reset --soft HEAD~1', 'moderate'],
    ['git checkout -b feat origin/main', 'moderate'],
    ['git restore --staged src/a.ts', 'moderate'],
    ['git clean -n', 'moderate'],
    ['git clean -fn', 'moderate'],
    ['git branch -d feat', 'moderate'],
    ['git commit -m "fix: x"', 'moderate'],
    ['git push -u origin main', 'moderate'],
    ['git push -n --force origin main', 'moderate'],
    ['git push --dry-run --mirror', 'moderate'],
    ['git branch -M main', 'moderate'],
    ['git checkout "$BRANCH"', 'safe'],
    ['git -C /repo switch main', 'safe'],
    ['git switch -C feat', 'safe'],
    ['git status > /dev/null', 'safe'],
    ['git reflog', 'safe'],
  ])('%s → %s', async (cmd, level) => {
    expect(await assessCommandRisk(cmd)).toBe(level)
  })

  it('原因说清是哪种丢失', async () => {
    const detail = await assessCommandRiskDetailed('git reset --hard')
    expect(detail.calls[0]?.reasons.join(' ')).toContain('git reset')
  })

  it('PowerShell 形态：-- 作为 flag 留下、组合短 flag 未拆开', () => {
    const base: AuditedCall = { cmd: 'git', flags: [], args: [], paths: [], redirects: [], raw: '', source: 'powershell' }
    expect(assessSubcommandRisk({ ...base, flags: ['--'], paths: ['checkout', 'a.ts'], endOfOptions: true })?.level)
      .toBe('dangerous')
    expect(assessSubcommandRisk({ ...base, flags: ['-fdx'], paths: ['clean'] })?.level).toBe('dangerous')
    expect(assessSubcommandRisk({ ...base, paths: ['checkout', 'main'] })).toBeUndefined()
    // 全局选项的值留在位置参数里、排在子命令前面
    expect(assessSubcommandRisk({ ...base, flags: ['-C', '--hard'], paths: ['C:\\repo', 'reset'] })?.level)
      .toBe('dangerous')
    expect(assessSubcommandRisk({ ...base, flags: ['-c', '-C'], paths: ['k=v', 'C:\\repo', 'stash', 'drop'] })?.level)
      .toBe('dangerous')
  })

  it('子命令名不会碰到对象自带属性', () => {
    const base: AuditedCall = { cmd: 'constructor', flags: [], args: [], paths: ['toString'], redirects: [], raw: '', source: 'bash' }
    expect(assessSubcommandRisk(base)).toBeUndefined()
    expect(assessSubcommandRisk({ ...base, cmd: 'git', paths: ['constructor'] })).toBeUndefined()
  })
})
