/**
 * @vitest-environment jsdom
 */
/**
 * 对话顶上那一行字：联络派出的任务写明「这是联络派出的任务」，其余什么都不出现。
 */
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it } from 'vitest'
import zhCN from '../../i18n/locales/zh-CN'
import enUS from '../../i18n/locales/en-US'
import AssignedByBanner from '../AssignedByBanner.vue'

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

afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

describe('AssignedByBanner 对话顶上的出身说明', () => {
  it('联络派出的任务：写明「这是联络派出的任务」，带图标，没有按钮', () => {
    const host = renderBanner('companion')
    const banner = host.querySelector('.assigned-by-banner')!
    expect(banner).not.toBeNull()
    expect(banner.textContent?.trim()).toBe('这是联络派出的任务')
    expect(banner.querySelector('svg')).not.toBeNull()
    expect(banner.querySelector('button')).toBeNull()
  })

  it('英文界面有对应的说法', () => {
    const host = renderBanner('companion', 'en-US')
    expect(host.querySelector('.assigned-by-banner')?.textContent?.trim()).toBe('This task was sent out by Reach')
  })

  it('没记下出身（用户自己开的、老任务）：什么都不出现', () => {
    expect(renderBanner(undefined).querySelector('.assigned-by-banner')).toBeNull()
  })

  it('不认识的取值、撞上对象属性名的取值：不出现，宁可不标也不标错', () => {
    expect(renderBanner('nobody').querySelector('.assigned-by-banner')).toBeNull()
    expect(renderBanner('constructor').querySelector('.assigned-by-banner')).toBeNull()
  })
})
