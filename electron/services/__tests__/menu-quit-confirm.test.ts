import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Menu: {},
  shell: {},
  clipboard: {},
  BrowserWindow: class {},
  app: { name: 'SailFish' },
}))

import { MenuService } from '../menu.service'

describe('退出确认的话', () => {
  const service = new MenuService()

  it('只有终端没关：只说终端', () => {
    const { detail } = service.getQuitConfirmDialogOptions({ terminals: 2, runningTasks: 0 })
    expect(detail).toBe('还有 2 个终端没关，退出会把它们关掉。')
  })

  it('只有任务在跑：只说任务', () => {
    const { detail } = service.getQuitConfirmDialogOptions({ terminals: 0, runningTasks: 1 })
    expect(detail).toBe('有 1 个任务正在进行，退出会把它们打断。')
  })

  it('两样都有：分两行各说各的', () => {
    const { detail } = service.getQuitConfirmDialogOptions({ terminals: 1, runningTasks: 3 })
    expect(detail.split('\n')).toEqual([
      '还有 1 个终端没关，退出会把它们关掉。',
      '有 3 个任务正在进行，退出会把它们打断。',
    ])
  })

  it('英文不分单复数', () => {
    service.setLanguage('en-US')
    const { detail } = service.getQuitConfirmDialogOptions({ terminals: 1, runningTasks: 1 })
    expect(detail).toBe(
      'Terminals still open: 1. Quitting will close them.\nTasks in progress: 1. Quitting will interrupt them.'
    )
    service.setLanguage('zh-CN')
  })
})
