/**
 * `cd 绝对路径 && 相对路径`：整条命令里唯一的 cd、在最前面的 && 串里时，后面的相对路径按它定下的目录算。
 * 其余写法一律照旧（不降级）。设计见 command-audit/SPEC.md 不变量 3。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return '/Users/yushen/Library/Application Support/SailFish'
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { assessShellRisk, defaultAuditContext } from '../assess-shell'
import { commandNeedsConfirm } from '../confirm-policy'
import { extractAuditedCalls } from '../extract-calls'
import { resetUserDataGuardForTest, setUserDataGuardForTest } from '../userdata-guard'

const USER_DATA = '/Users/yushen/Library/Application Support/SailFish'
const SCRATCH = path.join(USER_DATA, 'agent-workspace', 'scratch')

async function level(cmd: string) {
  const ctx = defaultAuditContext()
  const a = await assessShellRisk(cmd, ctx)
  return { level: a.level, askRelaxed: commandNeedsConfirm(a, 'relaxed'), assessment: a }
}

describe('认得 cd 绝对路径 && 相对路径', () => {
  it('真实被拦下的那条清理命令：不再需要确认', async () => {
    const r = await level(
      `cd "${SCRATCH}" && rm -rf out_test mailpkg exam/pdf && echo "临时文件已清理" && ls`,
    )
    expect(r.level).toBe('safe')
    expect(r.askRelaxed).toBe(false)
  })

  it('cd 到 scratch 的子目录再删相对路径', async () => {
    const r = await level(`cd "${SCRATCH}/exam" && rm -f pdf/a.pdf "pdf/b c.png"`)
    expect(r.level).toBe('safe')
  })

  it('不带引号、用反斜杠转义空格的目录', async () => {
    const r = await level(
      String.raw`cd /Users/yushen/Library/Application\ Support/SailFish/agent-workspace/scratch && rm -rf out_test`,
    )
    expect(r.level).toBe('safe')
  })

  it('系统临时目录同样算自由区', async () => {
    expect((await level('cd /tmp && rm -rf build_x')).level).toBe('safe')
  })

  it('管道里的命令也在 cd 之后', async () => {
    const r = await level(`cd "${SCRATCH}" && rm -rf old | cat`)
    expect(r.level).toBe('safe')
  })

  it('cd 之前的命令不受影响，仍按默认目录猜', async () => {
    const r = await level(`rm -rf before && cd "${SCRATCH}" && rm -rf after`)
    expect(r.level).toBe('dangerous')
  })

  it('cd 到桌面再删：位置确定是桌面，仍要确认', async () => {
    const r = await level('cd ~/Desktop && rm foo.txt')
    expect(r.level).toBe('dangerous')
    expect(r.askRelaxed).toBe(true)
    expect(r.assessment.calls.find(c => c.cmd === 'rm')?.pathZones).toEqual(['outside'])
  })

  it('cd 进 scratch 再用 .. 跑出去：按真实位置算，不再是自由区', async () => {
    const r = await level(`cd "${SCRATCH}" && rm -rf ../precious`)
    expect(r.level).not.toBe('safe')
    expect(r.askRelaxed).toBe(true)
  })

  it('cd 进系统目录再写相对路径的重定向：按系统目录算，要确认', async () => {
    const r = await level('cd /etc && echo x > hosts')
    expect(r.level).toBe('dangerous')
    expect(r.askRelaxed).toBe(true)
  })

  it('每条命令只带自己的锚点：cd 本身、cd 之前的命令没有', async () => {
    const { calls } = await extractAuditedCalls(
      `echo a && cd "${SCRATCH}" && rm -f x && ls`,
      defaultAuditContext(),
    )
    expect(calls.map(c => [c.cmd, c.anchorCwd])).toEqual([
      ['echo', undefined],
      ['cd', undefined],
      ['rm', SCRATCH],
      ['ls', SCRATCH],
    ])
  })
})

describe('认不出的写法：一律不降级（照旧要确认）', () => {
  const cases: Array<[string, string]> = [
    ['分号连接（cd 失败后面照样跑）', `cd "${SCRATCH}"; rm -rf out_test`],
    ['|| 连接', `cd "${SCRATCH}" || true && rm -rf out_test`],
    ['整串放进子 shell', `(cd "${SCRATCH}" && rm -rf out_test)`],
    ['放进花括号块', `{ cd "${SCRATCH}" && rm -rf out_test; }`],
    ['后台执行', `cd "${SCRATCH}" && rm -rf out_test &`],
    ['取反', `! cd "${SCRATCH}" && rm -rf out_test`],
    ['cd 在管道里', `cd "${SCRATCH}" | cat && rm -rf out_test`],
    ['cd 目录是变量', 'cd "$SCRATCH_DIR" && rm -rf out_test'],
    ['cd 目录带命令替换', `cd "$(pwd)" && rm -rf out_test`],
    ['cd 目录带通配符', `cd "${SCRATCH}/ex*" && rm -rf out_test`],
    ['cd 目录带 ..', `cd "${SCRATCH}/../scratch" && rm -rf out_test`],
    ['cd 目录是相对路径', 'cd exam && rm -rf out_test'],
    ['cd 到 ~user', 'cd ~root && rm -rf out_test'],
    ['cd 带选项', `cd -P "${SCRATCH}" && rm -rf out_test`],
    ['两个 cd', `cd "${SCRATCH}" && cd exam && rm -rf out_test`],
    ['pushd', `cd "${SCRATCH}" && pushd /etc && rm -rf out_test`],
    ['builtin cd', `builtin cd "${SCRATCH}" && rm -rf out_test`],
    ['command cd', `command cd "${SCRATCH}" && rm -rf out_test`],
    ['定义了函数', `f() { cd /; }; cd "${SCRATCH}" && f && rm -rf out_test`],
    ['source 一个脚本', `cd "${SCRATCH}" && source ./env.sh && rm -rf out_test`],
    ['eval', `cd "${SCRATCH}" && eval "cd /" && rm -rf out_test`],
    ['命令名是变量', `cd "${SCRATCH}" && $TOOL && rm -rf out_test`],
    ['前面有纯赋值（可能改 HOME）', `HOME=/x && cd ~ && rm -rf out_test`],
    ['sudo 包装（sudo -D 会换目录）', `cd "${SCRATCH}" && sudo rm -rf out_test`],
    ['env 包装（env -C 会换目录）', `cd "${SCRATCH}" && env -C /etc rm -rf out_test`],
    ['bash -c 内联脚本', `cd "${SCRATCH}" && bash -c 'rm -rf out_test'`],
    ['没有 cd 的相对路径', 'rm -rf out_test'],
  ]

  for (const [name, cmd] of cases) {
    it(name, async () => {
      // 根上：没有任何一条命令被认定了目录（不是碰巧因为别的原因要确认）
      const { calls } = await extractAuditedCalls(cmd, defaultAuditContext())
      expect(calls.filter(c => c.anchorCwd !== undefined).map(c => c.cmd), cmd).toEqual([])
      // 结果：照旧要确认
      const r = await level(cmd)
      expect(r.level, cmd).not.toBe('safe')
      expect(r.askRelaxed, cmd).toBe(true)
    })
  }
})

describe('cd 定下的目录也用于凭据禁区检查', () => {
  beforeAll(() => setUserDataGuardForTest(USER_DATA))
  afterAll(() => resetUserDataGuardForTest())

  it('cd 进数据目录再读相对路径的凭据文件：硬拒', async () => {
    const r = await level(`cd "${USER_DATA}" && cat credentials.json`)
    expect(r.level).toBe('blocked')
  })

  it('cd 进数据目录里允许的 agent-workspace 不受影响', async () => {
    const r = await level(`cd "${USER_DATA}/agent-workspace/scratch" && cat notes.txt`)
    expect(r.level).not.toBe('blocked')
  })
})

describe('符号链接：相对路径按进程所在的真实目录算', () => {
  let tmp: string

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-anchor-')))
    fs.symlinkSync(os.homedir(), path.join(tmp, 'link'))
  })
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('临时目录里的软链指向主目录：cd 进软链再删，不能当临时目录', async () => {
    const r = await level(`cd "${tmp}/link" && rm -rf notes.txt`)
    expect(r.level).toBe('dangerous')
    expect(r.askRelaxed).toBe(true)
  })

  it('同一个软链下用 ..：是主目录的上一层，不是临时目录', async () => {
    const r = await level(`cd "${tmp}/link" && rm -rf ../notes.txt`)
    expect(r.askRelaxed).toBe(true)
  })

  it('普通临时子目录照常放行', async () => {
    fs.mkdirSync(path.join(tmp, 'plain'))
    const r = await level(`cd "${tmp}/plain" && rm -rf notes.txt`)
    expect(r.level).toBe('safe')
  })
})

describe('对得上真实的 shell', () => {
  it('审计说安全的命令，在别的目录下真跑，删的是 cd 之后那个目录里的文件', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-anchor-real-')))
    try {
      const work = path.join(root, 'work')
      const elsewhere = path.join(root, 'elsewhere') // 进程实际所在的目录，里面有同名文件
      fs.mkdirSync(work)
      fs.mkdirSync(elsewhere)
      fs.writeFileSync(path.join(work, 'draft.txt'), 'x')
      fs.writeFileSync(path.join(elsewhere, 'draft.txt'), 'x')

      const cmd = `cd "${work}" && rm -f draft.txt && echo done`
      expect((await level(cmd)).level).toBe('safe')

      const out = execFileSync('/bin/bash', ['-c', cmd], { cwd: elsewhere }).toString()
      expect(out.trim()).toBe('done')
      expect(fs.existsSync(path.join(work, 'draft.txt'))).toBe(false)
      expect(fs.existsSync(path.join(elsewhere, 'draft.txt'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('cd 的目录不存在：后面的命令根本不会跑', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-anchor-miss-')))
    try {
      fs.writeFileSync(path.join(root, 'keep.txt'), 'x')
      const cmd = `cd "${root}/not-here" && rm -f keep.txt`
      try { execFileSync('/bin/bash', ['-c', cmd], { cwd: root, stdio: 'ignore' }) } catch { /* cd 失败退出非 0 */ }
      expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
