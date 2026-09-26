/**
 * 编程技能 - git 命令行调用
 * 只给技能自己用（看项目状态、影子仓库检查点）；模型要跑 git 走 exec。
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const GIT_NAME = process.platform === 'win32' ? 'git.exe' : 'git'
/** macOS 自带的 /usr/bin/git 是个壳：没装命令行工具时一调用就弹安装框 */
const MAC_GIT_SHIM = '/usr/bin/git'
const DEFAULT_TIMEOUT_MS = 30_000

export interface GitRunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export class GitCli {
  private static availability?: Promise<string | undefined>

  /** 能用的 git 路径；没有（或 mac 上只有会弹框的壳）返回 undefined */
  static locate(): Promise<string | undefined> {
    if (!GitCli.availability) GitCli.availability = GitCli.detect()
    return GitCli.availability
  }

  private static async detect(): Promise<string | undefined> {
    const onPath = findOnPath(GIT_NAME)
    if (!onPath) return undefined
    if (process.platform === 'darwin' && onPath === MAC_GIT_SHIM) {
      const ok = await new Promise<boolean>(resolve => {
        execFile('xcode-select', ['-p'], { timeout: 5000 }, err => resolve(!err))
      })
      if (!ok) return undefined
    }
    return onPath
  }

  static async run(args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
    const git = await GitCli.locate()
    if (!git) return { code: -1, stdout: '', stderr: 'git not available', timedOut: false }
    return new Promise(resolve => {
      execFile(
        git,
        args,
        {
          cwd: opts.cwd,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...opts.env },
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
          resolve({
            code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: Boolean(e?.killed),
          })
        },
      )
    })
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // 下一个
    }
  }
  return undefined
}
