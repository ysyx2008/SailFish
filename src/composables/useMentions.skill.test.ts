/**
 * @vitest-environment jsdom
 *
 * 技能列表的取数与选中：加号 / 星标打开的多选格子，和 @ 敲出来的单选列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

// 界面语言包里的译文，用例按需往里放（空着就等于没有译名）
const messages: Record<string, string> = {}
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => messages[key] ?? key, te: (key: string) => key in messages }),
}))
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
  for (const key of Object.keys(messages)) delete messages[key]
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

describe('技能列表的顺序（按名字拼音排）', () => {
  const row = (id: string, name: string): SkillRow => ({ id, name, description: '', enabled: true })
  const idsOf = (mentions: ReturnType<typeof setup>['mentions']) => mentions.suggestions.value.map(s => s.id)

  it('中文名按拼音：待办、飞书、日历、邮件', async () => {
    builtinList.mockResolvedValue([row('mail', '邮件'), row('feishu', '飞书'), row('todo', '待办'), row('cal', '日历')])
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(idsOf(mentions)).toEqual(['todo', 'feishu', 'cal', 'mail'])
  })

  it('中文名在前、英文名在后；英文按字母，数字按大小', async () => {
    builtinList.mockResolvedValue([
      row('word', 'Word'), row('j10', '技能 10'), row('excel', 'Excel'), row('j2', '技能 2'), row('todo', '待办'),
    ])
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(idsOf(mentions)).toEqual(['todo', 'j2', 'j10', 'excel', 'word'])
  })

  it('「我装的」「内置」两组照旧分开，各排各的', async () => {
    builtinList.mockResolvedValue([row('word', 'Word'), row('excel', 'Excel')])
    userList.mockResolvedValue([row('zed', 'Zed'), row('ant', 'Ant')])
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(idsOf(mentions)).toEqual(['user:ant', 'user:zed', 'excel', 'word'])
  })

  it('名字一样（连大小写差异也算）时按 id 定，每次顺序都一样', async () => {
    const rows = [row('b', 'Excel'), row('c', 'excel'), row('a', 'EXCEL')]
    for (const input of [rows, [...rows].reverse()]) {
      builtinList.mockResolvedValue(input)
      userList.mockResolvedValue([])
      const { mentions } = setup()
      mentions.openSkillMenu()
      await flush()
      expect(idsOf(mentions)).toEqual(['a', 'b', 'c'])
    }
  })

  it('@ 里也按这个顺序，先排好再取前 30 个', async () => {
    const many = Array.from({ length: 53 }, (_, i) => row(`s${i}`, `技能 ${i}`)).reverse()
    builtinList.mockResolvedValue(many)
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.detectTrigger('@s', 2)
    await flush()
    const ids = idsOf(mentions)
    expect(ids).toHaveLength(30)
    expect(ids[0]).toBe('s0')
    expect(ids[29]).toBe('s29')
  })
})

describe('内置技能显示界面语言下的名字（和设置页一致）', () => {
  const englishUi = () => {
    messages['skillSettings.builtinSkillNames.excel'] = 'Excel'
    messages['skillSettings.builtinSkillDescs.excel'] = 'Read and write spreadsheets'
  }

  it('有译名：内置技能显示译名和译文简介，自己装的技能照旧', async () => {
    englishUi()
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    const byId = Object.fromEntries(mentions.suggestions.value.map(s => [s.id, s]))
    expect(byId['excel'].label).toBe('Excel')
    expect(byId['excel'].description).toBe('Read and write spreadsheets')
    expect(byId['user:foo'].label).toBe('Foo 技能')
    expect(byId['user:foo'].description).toBe('自己写的')
  })

  it('没有译名的内置技能用后端给的原文', async () => {
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    const excel = mentions.suggestions.value.find(s => s.id === 'excel')
    expect(excel?.label).toBe('Excel 处理')
    expect(excel?.description).toBe('表格读写')
  })

  it('搜索按眼前看到的：能搜到译名和译文简介', async () => {
    englishUi()
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    mentions.setSkillSearch('spreadsheet')
    await flush()
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['excel'])
  })

  it('排序按译名排，不按中文原名', async () => {
    messages['skillSettings.builtinSkillNames.word'] = 'Apple Notes'
    messages['skillSettings.builtinSkillNames.excel'] = 'Zebra Sheets'
    builtinList.mockResolvedValue([
      { id: 'excel', name: 'Excel 处理', description: '', enabled: true },
      { id: 'word', name: 'Word 文档', description: '', enabled: true },
    ])
    userList.mockResolvedValue([])
    const { mentions } = setup()
    mentions.openSkillMenu()
    await flush()
    expect(mentions.suggestions.value.map(s => s.id)).toEqual(['word', 'excel'])
  })
})
