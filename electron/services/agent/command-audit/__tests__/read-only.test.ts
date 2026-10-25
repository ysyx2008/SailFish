/**
 * 只读判定：每条命令写明本机 / 远程的预期。
 * 'ok' = 接受；字符串 = 拒绝，且理由里要含这段话；'-' = 这一边不关心。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-read-only-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs, getWorkspacePath } from '../../tools/file'
import { checkReadOnlyCommand } from '../read-only'
import { resetUserCommandRulesForTest, clearUserCommandRulesTestState } from '../user-command-rules'
import { setUserDataGuardForTest, resetUserDataGuardForTest } from '../userdata-guard'
import { assessShellRisk } from '../assess-shell'
import { remoteAuditContext } from '../assess-shell'
import { assessCommandRiskDetailed } from '../../risk-assessor'

type Expect = 'ok' | string | '-'

const isWin = process.platform === 'win32'

/** [命令, 本机预期, 远程预期] */
const TABLE: Array<[string, Expect, Expect]> = [
  // —— 系统和资源 ——
  ['ls -la /tmp', 'ok', 'ok'],
  ['uptime', 'ok', 'ok'],
  ['df -h', 'ok', 'ok'],
  ['df -T -i', 'ok', 'ok'],
  ['free -g', 'ok', 'ok'],
  ['free -s 1', '不是只读', '不是只读'],
  ['cat /etc/os-release | head -5', 'ok', 'ok'],
  ['ps -ef | grep nginx', 'ok', 'ok'],
  ['date +%s', 'ok', 'ok'],
  ['date 010100002026', '参数会改动', '参数会改动'],
  ['hostname', 'ok', 'ok'],
  ['hostname newname', '参数会改动', '参数会改动'],
  ['uniq -c', 'ok', 'ok'],
  ['uniq in.txt out.txt', '参数会改动', '参数会改动'],

  // —— systemctl ——
  ['systemctl status nginx', 'ok', 'ok'],
  ['systemctl status nginx --no-pager -l', 'ok', 'ok'],
  ['systemctl is-active nginx', 'ok', 'ok'],
  ['systemctl is-enabled nginx', 'ok', 'ok'],
  ['systemctl is-failed nginx', 'ok', 'ok'],
  ['systemctl list-units --type service --state failed', 'ok', 'ok'],
  ['systemctl list-unit-files', 'ok', 'ok'],
  ['systemctl show nginx -p MainPID', 'ok', 'ok'],
  ['systemctl cat nginx', 'ok', 'ok'],
  ['systemctl restart nginx', '不是只读', '不是只读'],
  ['systemctl stop nginx', '不是只读', '不是只读'],
  ['systemctl daemon-reload', '不是只读', '不是只读'],
  ['systemctl status nginx -H other', '不是只读', '不是只读'],
  ['systemctl status nginx; systemctl stop nginx', '不是只读', '不是只读'],
  ['systemctl', '不是只读', '不是只读'],

  // —— docker ——
  ['docker ps', 'ok', 'ok'],
  ['docker ps -a --format "{{.Names}}"', 'ok', 'ok'],
  ['docker images', 'ok', 'ok'],
  ['docker inspect web', 'ok', 'ok'],
  ['docker logs --tail 100 web', 'ok', 'ok'],
  ['docker logs --tail=100 --since 10m web', 'ok', 'ok'],
  ['docker stats --no-stream', 'ok', 'ok'],
  ['docker version', 'ok', 'ok'],
  ['docker info', 'ok', 'ok'],
  ['docker logs -f web', '不是只读', '不是只读'],
  ['docker logs --follow web', '不是只读', '不是只读'],
  ['docker stats', '不是只读', '不是只读'],
  ['docker run --rm alpine ls', '不是只读', '不是只读'],
  ['docker exec web ls', '不是只读', '不是只读'],
  ['docker rm web', '不是只读', '不是只读'],
  ['docker -H tcp://x:2375 ps', '不是只读', '不是只读'],

  // —— journalctl / dmesg ——
  ['journalctl -u nginx -n 100 --no-pager', 'ok', 'ok'],
  ['journalctl --since "1 hour ago" -p err', 'ok', 'ok'],
  ['journalctl -f', '不是只读', '不是只读'],
  ['journalctl --follow -u nginx', '不是只读', '不是只读'],
  ['journalctl --vacuum-size=1G', '不是只读', '不是只读'],
  ['journalctl --vacuum-time=2d', '不是只读', '不是只读'],
  ['journalctl --rotate', '不是只读', '不是只读'],
  ['journalctl --flush', '不是只读', '不是只读'],
  ['dmesg -T | tail -20', 'ok', 'ok'],
  ['dmesg -c', '不是只读', '不是只读'],
  ['dmesg -C', '不是只读', '不是只读'],
  ['dmesg -w', '不是只读', '不是只读'],

  // —— 网络 ——
  ['ss -tlnp', 'ok', 'ok'],
  ['ss -s', 'ok', 'ok'],
  ['ss -K', '不是只读', '不是只读'],
  ['netstat -tulpn', 'ok', 'ok'],
  ['netstat -rn', 'ok', 'ok'],
  ['netstat -c', '不是只读', '不是只读'],
  ['ip addr', 'ok', 'ok'],
  ['ip addr show', 'ok', 'ok'],
  // 解析会把单横线的连写拆成单个字母，-brief 认不出来，只能拒绝
  ['ip -brief addr', '不是只读', '不是只读'],
  ['ip -br addr', '不是只读', '不是只读'],
  ['ip -b cmds.txt addr', '不是只读', '不是只读'],
  ['ip -s link show dev eth0', 'ok', 'ok'],
  ['ip route', 'ok', 'ok'],
  ['ip route list', 'ok', 'ok'],
  ['ip neigh show', 'ok', 'ok'],
  ['ip addr add 10.0.0.1/24 dev eth0', '不是只读', '不是只读'],
  ['ip link set eth0 down', '不是只读', '不是只读'],
  ['ip route flush all', '不是只读', '不是只读'],
  ['ip route del default', '不是只读', '不是只读'],
  ['ip -n ns1 addr show', '不是只读', '不是只读'],
  ['ip netns exec ns1 ls', '不是只读', '不是只读'],
  ['ip', '不是只读', '不是只读'],

  // —— 负载和 IO：带间隔要带次数 ——
  ['vmstat', 'ok', 'ok'],
  ['vmstat 1 5', 'ok', 'ok'],
  ['vmstat 1', '一直输出', '一直输出'],
  ['iostat', 'ok', 'ok'],
  ['iostat -x 1 3', 'ok', 'ok'],
  ['iostat -x 2', '一直输出', '一直输出'],
  ['mpstat -P ALL 1 3', 'ok', 'ok'],
  ['mpstat -P ALL 1', '一直输出', '一直输出'],
  ['sar -u 1 3', 'ok', 'ok'],
  ['sar -u 1', '一直输出', '一直输出'],
  ['sar -o /tmp/out 1 3', '不是只读', '不是只读'],
  ['top -bn1 | head -20', 'ok', 'ok'],
  ['top -b -n 1', 'ok', 'ok'],
  ['top', '一直输出', '一直输出'],
  ['top -b', '一直输出', '一直输出'],
  ['top -n 1', '一直输出', '一直输出'],

  // —— git：只有查看类子命令 ——
  ['git status', 'ok', 'ok'],
  ['git -C /srv/app log', 'ok', 'ok'],
  ['git diff HEAD~1', 'ok', 'ok'],
  ['git commit', '不是查看类', '不是查看类'],
  ['git add .', '不是查看类', '不是查看类'],
  ['git pull', '不是查看类', '不是查看类'],
  ['git checkout main', '不是查看类', '不是查看类'],
  ['git', '不是查看类', '不是查看类'],

  // —— 会写文件、会跑程序、不认识的 ——
  ['echo hi > /tmp/a.txt', '写文件的重定向', '写文件的重定向'],
  ['echo hi >> ./a.txt', '写文件的重定向', '写文件的重定向'],
  ['ls /tmp > /dev/null 2>&1', 'ok', 'ok'],
  ['cp a b', '会写文件', '会写文件'],
  ['cp a /tmp/b', '会写文件', '会写文件'],
  ['rm -rf /tmp/x', '不是只读', '不是只读'],
  ['touch x', '不是只读', '不是只读'],
  ['tee /tmp/x', '不是只读', '不是只读'],
  ['sort -o out in', '不是只读', '不是只读'],
  ['find / -name x -delete', '不是只读', '不是只读'],
  ['find . -fprint out', '不是只读', '不是只读'],
  ['curl http://example.com', '不是只读', '不是只读'],
  ['awk \'{print $1}\' /etc/hosts', '要跑一段程序', '要跑一段程序'],
  ['ps aux | awk \'{print $2}\'', '要跑一段程序', '要跑一段程序'],
  ['awk \'BEGIN{system("rm /tmp/x")}\'', '要跑一段程序', '要跑一段程序'],
  ['awk \'BEGIN{print "x" > "/tmp/y"}\'', '要跑一段程序', '要跑一段程序'],
  ['python3 x.py', '要跑一段程序', '要跑一段程序'],
  ['node a.js', '要跑一段程序', '要跑一段程序'],
  ['mytool status', '不认识', '不认识'],
  ['ls /tmp; mytool', '不认识', '不认识'],
  ['ls $(rm -rf /tmp/x)', '不是只读', '不是只读'],
  ['ls "$(touch /tmp/x)"', '不是只读', '不是只读'],

  // —— 本机和远程判得不一样的 ——
  ['ls $HOME', 'ok', '看不出值'],
  ['echo $(date)', 'ok', '看不出值'],
  ['sudo ls /var/log', '-', '转手执行'],
  ['env FOO=1 ls', '-', '转手执行'],
  ['nohup ls', '-', '转手执行'],
]

function matches(result: string | null, expected: Expect): boolean {
  if (expected === '-') return true
  if (expected === 'ok') return result === null
  return result !== null && result.includes(expected)
}

describe('只读判定', () => {
  beforeAll(async () => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    const { ensureShellAstReady } = await import('../parser')
    await ensureShellAstReady()
  })

  afterAll(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it.skipIf(isWin).each(TABLE.filter(([, local]) => local !== '-'))('本机：%s → %s', async (command, local) => {
    const result = await checkReadOnlyCommand(command, { kind: 'local' })
    expect(matches(result, local), `${command} → ${result}`).toBe(true)
  })

  it.each(TABLE.filter(([, , remote]) => remote !== '-'))('远程：%s → (本机 %s) → %s', async (command, _local, remote) => {
    const result = await checkReadOnlyCommand(command, { kind: 'remote' })
    expect(matches(result, remote), `${command} → ${result}`).toBe(true)
  })

  it('拒绝时写明哪条命令、为什么，不只给一个等级', async () => {
    const result = await checkReadOnlyCommand('ls /tmp; vmstat 1', { kind: 'remote' })
    expect(result).toContain('vmstat')
    expect(result).toContain('一直输出')
  })

  it('空命令和解析不了的命令都拒绝', async () => {
    expect(await checkReadOnlyCommand('', { kind: 'remote' })).not.toBeNull()
    expect(await checkReadOnlyCommand('ls | | cat', { kind: 'remote' })).not.toBeNull()
    expect(await checkReadOnlyCommand('echo "unterminated', { kind: 'remote' })).not.toBeNull()
  })
})

describe('远程的处境：不拿本机的东西来判', () => {
  const tmpDir = path.join(os.tmpdir(), `sft-read-only-rules-${Date.now()}`)

  beforeAll(async () => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    const { ensureShellAstReady } = await import('../parser')
    await ensureShellAstReady()
  })

  afterEach(() => {
    clearUserCommandRulesTestState()
    resetUserDataGuardForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.skipIf(isWin)('用户为本机加的规则：本机认，远程不认', async () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    const store = resetUserCommandRulesForTest(path.join(tmpDir, 'rules.json'))
    const added = await store.upsert({ cmd: 'mycli', baseLevel: 'safe', writesTo: false, safeFlags: '-n' })
    expect(added.ok).toBe(true)
    expect(await checkReadOnlyCommand('mycli -n', { kind: 'local' })).toBeNull()
    expect(await checkReadOnlyCommand('mycli -n', { kind: 'remote' })).toContain('不认识')
  })

  it.skipIf(isWin)('本机的工作区和临时目录在远程不是自由区：本机把它们当安全，远程的结果不变', async () => {
    const ws = getWorkspacePath()
    // 写这些地方在本机会被降成安全；只读判定本来就不接受写文件，本机远程一样拒
    for (const command of [`touch ${ws}/scratch/a`, `mkdir ${ws}/scratch/b`, 'touch /tmp/a', 'cp /etc/hosts /tmp/hosts']) {
      expect(await checkReadOnlyCommand(command, { kind: 'local' }), command).not.toBeNull()
      expect(await checkReadOnlyCommand(command, { kind: 'remote' }), command).not.toBeNull()
    }
  })

  it('远程的审计不做路径分区：本机数据目录路径对远程命令没有特殊含义', async () => {
    // 远程主机上恰好有同名路径，读它是普通读
    setUserDataGuardForTest(mockUserData)
    const credentials = path.join(mockUserData, 'credentials.json')
    const a = await assessShellRisk(`cat ${credentials}`, remoteAuditContext())
    expect(a.level).toBe('safe')
    const local = await assessCommandRiskDetailed(`cat ${credentials}`)
    expect(local.level).not.toBe('safe')
  })

  it('远程 `~` 不展开成本机主目录', async () => {
    const a = await assessShellRisk('cat ~/.bashrc', remoteAuditContext())
    expect(a.level).toBe('safe')
    expect(a.calls[0]!.pathZones ?? []).toEqual([])
  })
})
