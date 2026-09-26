/**
 * 等后台命令时的卡片文案：命令开头一小截 + 已运行多久，不贴整条命令、不亮内部编号
 */
import { describe, it, expect, vi } from 'vitest'

const { tmpUserData } = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { tmpUserData: path.join(os.tmpdir(), `sft-exec-awaiting-${process.pid}`) }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmpUserData),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

import { formatAwaitingTitle, describeAwaitExecCall } from '../tools/exec'

describe('formatAwaitingTitle', () => {
  it('短命令原样带上，外加已运行时长', () => {
    const text = formatAwaitingTitle('npm test', '3秒')
    expect(text).toContain('npm test')
    expect(text).toContain('3秒')
  })

  it('长命令只取开头一小截，用省略号收尾', () => {
    const command = 'sleep 120; echo "命令结束（本应等满60秒窗口才转后台）"; echo more output here'
    const text = formatAwaitingTitle(command, '53秒')
    expect(text).toContain('sleep 120; echo')
    expect(text).toContain('…')
    expect(text).not.toContain('more output here')
  })

  it('多行命令只取第一行', () => {
    const text = formatAwaitingTitle('cd /tmp\n./build.sh --all', '1分钟')
    expect(text).toContain('cd /tmp…')
    expect(text).not.toContain('build.sh')
  })
})

describe('describeAwaitExecCall', () => {
  it('认不出的命令不亮编号，也不冒出内部等待参数', () => {
    const text = describeAwaitExecCall({ task_id: 'exec-999', pattern: 'Listening on 🍕' })
    expect(text).not.toMatch(/exec-999|Listening|🍕/)
  })

  it('停掉和改标常驻有各自的说法，同样不亮编号', () => {
    const stop = describeAwaitExecCall({ task_id: 'exec-1', stop: true })
    const service = describeAwaitExecCall({ task_id: 'exec-1', service: true })
    expect(stop).toMatch(/停掉|Stopping/)
    expect(service).toMatch(/常驻|long-running/)
    expect(`${stop}${service}`).not.toContain('exec-1')
  })
})
