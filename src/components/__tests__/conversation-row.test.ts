/**
 * @vitest-environment jsdom
 */
/**
 * 侧栏「最近对话」行首的来历标志：
 * 终端会话带终端图标；联络派的任务带纸飞机；用户自己开的助手会话什么都不带。
 * 图标上的说明鼠标一放上去就弹出，不靠浏览器自带的、要等一秒的悬停提示。
 */
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it } from 'vitest'
import zhCN from '../../i18n/locales/zh-CN'
import ConversationRow from '../ConversationRow.vue'
import type { AgentHistorySummary } from '@shared/types'

const mounted: Array<() => void> = []

function renderRow(record: Partial<AgentHistorySummary>, props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(ConversationRow, {
      record: {
        id: 's1',
        timestamp: 1,
        duration: 1,
        userTask: '整理一下日志',
        title: '整理日志',
        terminalType: 'assistant',
        status: 'completed',
        ...record,
      } as AgentHistorySummary,
      formattedTime: '10:00',
      ...props,
    }),
  })
  app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } }))
  app.mount(host)
  mounted.push(() => { app.unmount(); host.remove() })
  return { host, unmount: () => app.unmount() }
}

const marks = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>('.origin-mark'))
const markLabels = (host: HTMLElement) => marks(host).map(el => el.getAttribute('aria-label'))
const tipText = () => document.body.querySelector('.hover-tip-floating')?.textContent?.trim() ?? null

const hover = async (el: Element) => {
  el.dispatchEvent(new MouseEvent('mouseenter'))
  await nextTick()
}
const leave = async (el: Element) => {
  el.dispatchEvent(new MouseEvent('mouseleave'))
  await nextTick()
}

afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

describe('ConversationRow 来历标志', () => {
  it('联络派的任务：带一个标志，说明是「联络派出的任务」', () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    expect(markLabels(host)).toEqual(['联络派出的任务'])
    expect(marks(host)[0].querySelector('svg')).not.toBeNull()
  })

  it('用户自己开的助手会话：没有标志', () => {
    expect(markLabels(renderRow({}).host)).toEqual([])
  })

  it('没记下出身的老任务、不认识的取值：不标，宁可不标也不标错', () => {
    expect(markLabels(renderRow({ assignedBy: undefined }).host)).toEqual([])
    expect(markLabels(renderRow({ assignedBy: 'nobody' as never }).host)).toEqual([])
    // 取值恰好撞上对象自带的属性名也不能被当成出身
    expect(markLabels(renderRow({ assignedBy: 'constructor' as never }).host)).toEqual([])
  })

  it('终端会话仍是终端标志（说明给主机），不会被当成联络派的', () => {
    const { host } = renderRow({ terminalType: 'ssh', terminalId: 'tab-1', sshHost: 'prod-1' })
    expect(markLabels(host)).toEqual(['prod-1'])
  })

  it('改名编辑时不画标志，免得挡住输入框', () => {
    const { host } = renderRow({ assignedBy: 'companion' }, { isEditing: true, editingTitle: '新名字' })
    expect(markLabels(host)).toEqual([])
  })

  it('行的悬停提示不变：仍只补全标题，不放会话正文', () => {
    const { host } = renderRow({ assignedBy: 'companion', userTask: '一大段粘贴进来的正文'.repeat(30) })
    expect(host.querySelector('.conversation-item')!.getAttribute('title')).toBe('整理日志')
  })
})

describe('来历标志的说明：放上去就出现', () => {
  it('平时不显示；鼠标一放上去马上出现，移开就收起', async () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    expect(tipText()).toBeNull()

    const mark = marks(host)[0]
    await hover(mark)
    expect(tipText()).toBe('联络派出的任务')

    await leave(mark)
    expect(tipText()).toBeNull()
  })

  it('终端标志同一种做法，说明是主机名', async () => {
    const { host } = renderRow({ terminalType: 'ssh', terminalId: 'tab-1', sshHost: 'prod-1' })
    await hover(marks(host)[0])
    expect(tipText()).toBe('prod-1')
  })

  it('说明挂在页面最外层，不会被侧栏列表的滚动区域裁掉', async () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    await hover(marks(host)[0])
    const tip = document.body.querySelector('.hover-tip-floating')!
    expect(host.contains(tip)).toBe(false)
  })

  it('说明放在图标下方、左端与图标对齐——图标贴着窗口左缘，居中会伸出窗口', async () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    const mark = marks(host)[0]
    mark.getBoundingClientRect = () => ({ left: 26, right: 47, top: 20, bottom: 43, width: 21, height: 23, x: 26, y: 20, toJSON: () => ({}) })
    await hover(mark)

    const tip = document.body.querySelector<HTMLElement>('.hover-tip-floating')!
    expect(tip.classList.contains('hover-tip-floating--bottom-start')).toBe(true)
    expect(tip.style.left).toBe('26px')
    expect(tip.style.top).toBe('51px')
  })

  it('较长的说明（比如很长的主机名）换行显示，不被截断', async () => {
    const { host } = renderRow({ terminalType: 'ssh', terminalId: 'tab-1', sshHost: 'a-very-long-host-name.internal.example.com' })
    await hover(marks(host)[0])
    const tip = document.body.querySelector('.hover-tip-floating')!
    expect(tip.classList.contains('hover-tip-floating--wrap')).toBe(true)
    expect(tip.textContent?.trim()).toBe('a-very-long-host-name.internal.example.com')
  })

  it('图标上不再挂浏览器自带提示（title 留空，免得冒出整行标题的第二个提示）', () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    expect(marks(host)[0].getAttribute('title')).toBe('')
  })

  it('弹出时这行被删掉或关掉，说明不留在页面上', async () => {
    const { host, unmount } = renderRow({ assignedBy: 'companion' })
    await hover(marks(host)[0])
    expect(tipText()).not.toBeNull()

    unmount()
    await nextTick()
    expect(tipText()).toBeNull()
  })

  it('按下鼠标（点开这条对话）时说明收起', async () => {
    const { host } = renderRow({ assignedBy: 'companion' })
    const mark = marks(host)[0]
    await hover(mark)
    expect(tipText()).not.toBeNull()

    mark.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(tipText()).toBeNull()
  })
})
