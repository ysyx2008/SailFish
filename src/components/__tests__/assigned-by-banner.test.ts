/**
 * @vitest-environment jsdom
 */
/**
 * 对话顶上那一行字：联络派出的任务写明「这是 XX 派出的任务」，XX 是智能体自己的名字
 * （用户起了名用用户的，没起用默认名）；其余什么都不出现。
 */
import { createApp, h, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '../../i18n/locales/zh-CN'
import enUS from '../../i18n/locales/en-US'
import appI18n, { setLocale } from '../../i18n'
import AssignedByBanner from '../AssignedByBanner.vue'

// 配置仓库一建出来就要连 Electron 的桥；这里只关心智能体的名字字段，换成一个同样响应式的替身
const configStub = vi.hoisted(() => ({ current: null as null | { agentName: string } }))
vi.mock('../../stores/config', () => ({ useConfigStore: () => configStub.current }))

const mounted: Array<() => void> = []

function renderBanner(assignedBy: unknown, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(AssignedByBanner, { assignedBy: assignedBy as string | undefined }),
  })
  app.use(createI18n({
    legacy: false,
    locale,
    messages: { 'zh-CN': zhCN, 'en-US': enUS },
  }))
  app.mount(host)
  mounted.push(() => { app.unmount(); host.remove() })
  return host
}

beforeEach(() => {
  configStub.current = reactive({ agentName: '' })
  // 默认名取自应用本身的语言，不受运行环境的浏览器语言影响
  setLocale('zh-CN')
})

afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

describe('AssignedByBanner 对话顶上的出身说明', () => {
  it('用户给智能体起了名：写「这是 <用户起的名字> 派出的任务」，带图标，没有按钮', () => {
    configStub.current!.agentName = '小蓝'
    const host = renderBanner('companion')
    const banner = host.querySelector('.assigned-by-banner')!
    expect(banner).not.toBeNull()
    expect(banner.textContent?.trim()).toBe('这是小蓝派出的任务')
    expect(banner.querySelector('svg')).not.toBeNull()
    expect(banner.querySelector('button')).toBeNull()
  })

  it('没起名（或只填了空格）：写默认名字，不再写「联络」', () => {
    const defaultName = appI18n.global.t('app.title')
    for (const blank of ['', '   ']) {
      configStub.current!.agentName = blank
      const text = renderBanner('companion').querySelector('.assigned-by-banner')!.textContent?.trim()
      expect(text).toBe(`这是${defaultName}派出的任务`)
      expect(text).not.toContain('联络')
    }
  })

  it('英文界面有对应的说法', () => {
    configStub.current!.agentName = 'Jarvis'
    const host = renderBanner('companion', 'en-US')
    expect(host.querySelector('.assigned-by-banner')?.textContent?.trim()).toBe('This task was sent out by Jarvis')
  })

  it('名字改了，这一行跟着变，不用重开对话', async () => {
    const config = configStub.current!
    config.agentName = '小蓝'
    const host = renderBanner('companion')
    expect(host.querySelector('.assigned-by-banner')?.textContent?.trim()).toBe('这是小蓝派出的任务')
    config.agentName = '阿鱼'
    await Promise.resolve()
    expect(host.querySelector('.assigned-by-banner')?.textContent?.trim()).toBe('这是阿鱼派出的任务')
  })

  it('没记下出身（用户自己开的、老任务）：什么都不出现', () => {
    expect(renderBanner(undefined).querySelector('.assigned-by-banner')).toBeNull()
  })

  it('不认识的取值、撞上对象属性名的取值：不出现，宁可不标也不标错', () => {
    expect(renderBanner('nobody').querySelector('.assigned-by-banner')).toBeNull()
    expect(renderBanner('constructor').querySelector('.assigned-by-banner')).toBeNull()
  })
})
