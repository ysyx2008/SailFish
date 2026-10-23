/**
 * 「免确认的目录」清单：设置页展示、评审员的「事先放开的目录」都从这里取，
 * 必须和审计真正判定的自由区是同一份。
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

import * as path from 'path'
import { getBuiltinFreeDirs, getWorkspaceZone, listFreeZoneDirs } from '../workspace-guard'
import { getBuiltInRulesView, resetBuiltInRulesViewCacheForTest } from '../built-in-rules-view'

const WORKSPACE = '/Users/yushen/Library/Application Support/SailFish/agent-workspace'

describe('免确认目录清单', () => {
  it('内置的有草稿、图表、迁移三个工作区目录和系统临时目录', () => {
    const dirs = getBuiltinFreeDirs()
    expect(dirs).toContain(path.join(WORKSPACE, 'scratch'))
    expect(dirs).toContain(path.join(WORKSPACE, 'charts'))
    expect(dirs).toContain(path.join(WORKSPACE, 'migrations'))
    expect(dirs.some(d => d === '/tmp' || d.endsWith('/tmp'))).toBe(true)
  })

  it('用户额外加的目录排在内置之后，去重、去空白、忽略空项', () => {
    const dirs = listFreeZoneDirs(['  /data/shared-scratch  ', '', '   ', '/data/shared-scratch', path.join(WORKSPACE, 'scratch')])
    const builtin = getBuiltinFreeDirs()
    expect(dirs.slice(0, builtin.length)).toEqual(builtin)
    expect(dirs.filter(d => d === '/data/shared-scratch')).toHaveLength(1)
    expect(dirs.filter(d => d === path.join(WORKSPACE, 'scratch'))).toHaveLength(1)
    expect(dirs.at(-1)).toBe('/data/shared-scratch')
  })

  it('不写额外目录就只有内置的', () => {
    expect(listFreeZoneDirs()).toEqual(getBuiltinFreeDirs())
    expect(listFreeZoneDirs([])).toEqual(getBuiltinFreeDirs())
  })

  it('清单里的每一处，审计都真的当自由区（同源）', () => {
    const extra = ['/data/shared-scratch']
    for (const dir of listFreeZoneDirs(extra)) {
      expect(getWorkspaceZone(path.join(dir, 'some-file.txt'), undefined, extra), dir).toBe('free')
    }
  })

  it('设置页展示的内置自由区就是这份清单', () => {
    resetBuiltInRulesViewCacheForTest()
    expect(getBuiltInRulesView().workspaceZones.free).toEqual(getBuiltinFreeDirs())
  })
})
