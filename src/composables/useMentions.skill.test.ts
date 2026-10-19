/**
 * @vitest-environment jsdom
 *
 * 技能列表的取数与选中：加号 / 星标打开的多选格子，和 @ 敲出来的单选列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../stores/terminal', () => ({ useTerminalStore: () => ({}) }))

import { useMentions } from './useMentions'

interface SkillRow { id: string; name: string; description: string; enabled: boolean }

const EXCEL: SkillRow = { id: 'excel', name: 'Excel 处理', description: '表格读写', enabled: true }
const FOO: SkillRow = { id: 'foo', name: 'Foo 技能', description: '自己写的', enabled: true }

const builtinList = vi.fn<() => Promise<SkillRow[]>>()
const userList = vi.fn<() => Promise<SkillRow[]>>()

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup() {
  const onSkillPicked = vi.fn()
  const onSkillToggle = vi.fn()
  const mentions = useMentions(
    ref(''),
    ref('tab-1'),
    computed(() => []),
    onSkillPicked,
    onSkillToggle
  )
  return { mentions, onSkillPicked, onSkillToggle }
}

beforeEach(() => {
  builtinList.mockReset().mockResolvedValue([EXCEL])
  userList.mockReset().mockResolvedValue([FOO])
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    builtinSkill: { list: builtinList },
    userSkill: { list: userList },
  }
})

describe('技能列表（加号 / 星标打开的多选格子）', () => {
  it('列出已启用的技能，自己写的带 user: 前缀', async () => {
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(mentions.skillMenuStandalone.value).toBe(true)
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['user:foo', 'excel'])
  })

  it('从开着的 @ 菜单切过来：技能还没回来之前，不留着 @ 菜单的旧项', async () => {
    const { mentions } = setup()
    mentions.suggestions.value = [{ id: 'cmd-file', type: 'command', label: '文件', icon: '📄' }] as typeof mentions.suggestions.value
    mentions.showMenu.value = true
    let release: (rows: SkillRow[]) => void = () => {}
    builtinList.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    mentions.openSkillMenu()
    expect(mentions.skillMenuStandalone.value).toBe(true)
    expect(mentions.suggestions.value).toEqual([])
    release([EXCEL])
    await flush()
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['user:foo', 'excel'])
  })

  it('点一个：交给「开关」回调，列表不收起、选中位置不动', async () => {
    const { mentions, onSkillPicked, onSkillToggle } = setup()
    mentions.openSkillMenu()
    await flush()
    mentions.selectedIndex.value = 1
    mentions.selectSuggestion(mentions.suggestions.value[1])
    expect(onSkillToggle).toHaveBeenCalledWith({ id: 'excel', name: 'Excel 处理', description: '表格读写' })
    expect(onSkillPicked).not.toHaveBeenCalled()
    expect(mentions.showMenu.value).toBe(true)
    expect(mentions.selectedIndex.value).toBe(1)
  })

  it('连点同一个也每次都交给回调，不在这一层吞掉', async () => {
    const { mentions, onSkillToggle } = setup()
    mentions.openSkillMenu()
    await flush()
    const first = mentions.suggestions.value[0]
    mentions.selectSuggestion(first)
    mentions.selectSuggestion(first)
    expect(onSkillToggle).toHaveBeenCalledTimes(2)
    expect(mentions.showMenu.value).toBe(true)
  })

  it('搜索乱序返回：先发出的慢请求后到，也不盖掉后发出的结果', async () => {
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()

    let releaseSlow: () => void = () => {}
    builtinList.mockImplementationOnce(
      () => new Promise<SkillRow[]>(resolve => { releaseSlow = () => resolve([EXCEL]) })
    )
    mentions.setSkillSearch('excel') // 慢：卡在内置技能列表上
    mentions.setSkillSearch('foo') // 快：马上返回，只剩自己写的 Foo
    await flush()
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['user:foo'])
    expect(mentions.isLoading.value).toBe(false)

    releaseSlow()
    await flush()
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['user:foo'])
    expect(mentions.isLoading.value).toBe(false)
  })

  it('旧请求还没回来时，加载中状态一直挂着，直到最新那次落地', async () => {
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()

    let releaseLatest: () => void = () => {}
    builtinList.mockImplementationOnce(() => new Promise<SkillRow[]>(resolve => resolve([EXCEL]))) // 旧：很快回
    builtinList.mockImplementationOnce(
      () => new Promise<SkillRow[]>(resolve => { releaseLatest = () => resolve([EXCEL]) })
    ) // 新：慢
    mentions.setSkillSearch('e')
    mentions.setSkillSearch('ex')
    await flush()
    expect(mentions.isLoading.value).toBe(true)

    releaseLatest()
    await flush()
    expect(mentions.isLoading.value).toBe(false)
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['excel'])
  })

  it('加载失败：列表清空、选中归零、不留加载中', async () => {
    const { mentions } = setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    builtinList.mockRejectedValueOnce(new Error('ipc down'))
    mentions.openSkillMenu()
    await flush()
    expect(mentions.suggestions.value).toEqual([])
    expect(mentions.selectedIndex.value).toBe(0)
    expect(mentions.isLoading.value).toBe(false)
    err.mockRestore()
  })

  it('面板列出全部开着的技能，不只前 30 个', async () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ id: `s${i}`, name: `技能 ${i}`, description: '', enabled: true }))
    builtinList.mockResolvedValue(many)
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(mentions.suggestions.value).toHaveLength(53)
  })

  it('加载技能时清掉文件补全残留的「还有 N 项」', async () => {
    const { mentions } = setup()
    mentions.hasMore.value = true
    mentions.totalCount.value = 80
    mentions.openSkillMenu()
    await flush()
    expect(mentions.hasMore.value).toBe(false)
    expect(mentions.totalCount.value).toBe(0)
  })
})

describe('在输入框里敲 @ 选技能（保持原样）', () => {
  it('@ 是边打字边挑，仍只列前 30 个', async () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ id: `s${i}`, name: `技能 ${i}`, description: '', enabled: true }))
    builtinList.mockResolvedValue(many)
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.detectTrigger('@s', 2)
    await flush()
    expect(mentions.suggestions.value).toHaveLength(30)
  })

  it('选一个就收起，走「选中」回调而不是「开关」', async () => {
    const { mentions, onSkillPicked, onSkillToggle } = setup()
    mentions.detectTrigger('@s', 2)
    await flush()
    expect(mentions.showMenu.value).toBe(true)
    expect(mentions.skillMenuStandalone.value).toBe(false)
    mentions.selectSuggestion(mentions.suggestions.value[0])
    expect(onSkillPicked).toHaveBeenCalledTimes(1)
    expect(onSkillToggle).not.toHaveBeenCalled()
    expect(mentions.showMenu.value).toBe(false)
  })
})
