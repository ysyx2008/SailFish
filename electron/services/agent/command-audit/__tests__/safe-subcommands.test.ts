/**
 * 查看用的子命令按安全算：systemctl / docker 等整条按中风险的运维命令，
 * 查看状态的子命令降为安全，其余照旧。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-safe-subcommands-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs } from '../../tools/file'
import { assessCommandRisk } from '../../risk-assessor'
import { defaultAuditContext } from '../assess-shell'
import type { RiskLevel } from '@shared/types/agent'

const isWin = process.platform === 'win32'

async function level(command: string, executionMode: 'strict' | 'relaxed' = 'relaxed'): Promise<RiskLevel> {
  return assessCommandRisk(command, { ...defaultAuditContext(), executionMode })
}

describe.skipIf(isWin)('查看用的子命令', () => {
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
    'systemctl status nginx',
    'systemctl is-active nginx',
    'systemctl list-units --type service',
    'docker ps -a',
    'docker logs --tail 50 web',
    'docker stats --no-stream',
    'ip addr show',
    'journalctl -u nginx -n 50 --no-pager',
    'top -bn1',
    'vmstat 1 3',
  ])('%s 是安全', async cmd => {
    expect(await level(cmd, 'relaxed')).toBe('safe')
    expect(await level(cmd, 'strict')).toBe('safe')
  })

  it.each([
    ['systemctl restart nginx', 'moderate'],
    ['systemctl disable nginx', 'moderate'],
    ['docker rm web', 'moderate'],
    ['docker logs -f web', 'moderate'],
    ['ip link set eth0 down', 'moderate'],
    ['journalctl --vacuum-size=1G', 'moderate'],
    ['top', 'moderate'],
    ['vmstat 1', 'moderate'],
  ] as Array<[string, RiskLevel]>)('%s 照旧按中风险', async (cmd, expected) => {
    expect(await level(cmd, 'relaxed')).toBe(expected)
  })

  it('docker run / exec 仍是「转手执行别的命令」：宽松中风险，严格高风险（原来怎样现在怎样）', async () => {
    expect(await level('docker run --rm alpine ls', 'relaxed')).toBe('moderate')
    expect(await level('docker exec web ls', 'relaxed')).toBe('moderate')
    expect(await level('docker run --rm alpine ls', 'strict')).toBe('dangerous')
  })

  it('子命令查看，但连着别的危险命令时，整体取最高', async () => {
    expect(await level('systemctl status nginx && rm -rf /srv/app', 'relaxed')).toBe('dangerous')
    expect(await level('docker ps; docker rm web', 'relaxed')).toBe('moderate')
  })

  it('选项值看不出来时不降级', async () => {
    expect(await level('systemctl status "$UNIT"', 'relaxed')).toBe('moderate')
    expect(await level('docker $SUB ps', 'relaxed')).not.toBe('safe')
  })

  it('命令表上没有的子命令不认', async () => {
    expect(await level('systemctl frobnicate', 'relaxed')).toBe('moderate')
    expect(await level('docker frobnicate', 'relaxed')).toBe('moderate')
  })
})
