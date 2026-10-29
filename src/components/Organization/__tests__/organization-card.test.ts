// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { expect, it, vi } from 'vitest'
import OrganizationCard from '../OrganizationCard.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

it('仅等负责人时保留等待提示，不显示都干完了', () => {
  const container = document.createElement('div')
  const app = createApp({ render: () => h(OrganizationCard, { organization: {
    members: [{ id: 'a', name: 'a', description: 'a', status: 'completed' }],
    teams: [{ name: '团', review: 'none', waitingLeader: true, messageCount: 1, wakeLimit: 30 }],
    total: 1, live: 0,
  } }) })
  try {
    app.mount(container)
    expect(container.textContent).toContain('summaryWaiting')
    expect(container.textContent).not.toContain('cardAllDone')
  } finally { app.unmount() }
})
