/**
 * 在本机起真的 sshd（临时配置、临时主机密钥、高端口、密钥登录当前用户）。
 * 给端到端验证用：假主机验证不了「超时后远程进程到底有没有消失」这类取决于真 sshd 行为的事。
 */
import { execFile, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RealSshd {
  port: number
  /** 当前用户名（sshd 以当前用户跑，只能登录这个用户） */
  username: string
  /** 能登录它的私钥文件 */
  privateKeyPath: string
  stop(): Promise<void>
}

export interface RealSshdFleet {
  hosts: RealSshd[]
  dir: string
  stop(): Promise<void>
}

/** 向系统要一个当下空闲的端口（别的进程，包括上次没收干净的 sshd，占着的不会被选中） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

export function hasRealSshd(): boolean {
  return process.platform !== 'win32' && fs.existsSync('/usr/sbin/sshd') && spawnSync('which', ['ssh-keygen']).status === 0
}

async function keygen(file: string): Promise<void> {
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file])
}

/**
 * 起 count 个 sshd，各占一个端口。共用一把登录用的钥匙，主机密钥各自一把。
 * 端口向系统要空闲的。
 */
export async function startRealSshds(
  count: number,
  opts: { allowTcpForwarding?: boolean[] } = {},
): Promise<RealSshdFleet> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-real-sshd-'))
  const clientKey = path.join(dir, 'client_key')
  await keygen(clientKey)
  const authorizedKeys = path.join(dir, 'authorized_keys')
  fs.copyFileSync(`${clientKey}.pub`, authorizedKeys)
  fs.chmodSync(authorizedKeys, 0o600)
  fs.chmodSync(clientKey, 0o600)

  const username = os.userInfo().username
  const hosts: RealSshd[] = []

  for (let i = 0; i < count; i++) {
    const hostKey = path.join(dir, `host_key_${i}`)
    await keygen(hostKey)
    const pidFile = path.join(dir, `sshd_${i}.pid`)
    const config = path.join(dir, `sshd_${i}.conf`)
    const myPort = await freePort()
    fs.writeFileSync(config, [
      `Port ${myPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${pidFile}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      'LogLevel ERROR',
      `AllowTcpForwarding ${opts.allowTcpForwarding?.[i] === false ? 'no' : 'yes'}`,
      'MaxStartups 200:30:300',
      'MaxSessions 100',
      '',
    ].join('\n'))
    await execFileAsync('/usr/sbin/sshd', ['-f', config, '-E', path.join(dir, `sshd_${i}.log`)])
    hosts.push({
      port: myPort,
      username,
      privateKeyPath: clientKey,
      async stop() {
        try {
          const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim())
          if (pid) process.kill(pid, 'SIGTERM')
        } catch { /* 已经停了 */ }
      },
    })
  }

  return {
    hosts,
    dir,
    async stop() {
      for (const h of hosts) await h.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 本机上有没有命令行里带这段标记的进程 */
export async function localProcessExists(marker: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', marker])
    // pgrep 自己不会匹配自己；测试进程的命令行里带标记的话要自己避开
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
