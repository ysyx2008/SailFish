import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }))

import { Ripgrep, RipgrepError } from '../ripgrep'

const binary = Ripgrep.locate()
let root: string

function write(rel: string, content: string, mtimeSec?: number): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  if (mtimeSec) fs.utimesSync(p, mtimeSec, mtimeSec)
}

describe.skipIf(!binary)('Ripgrep', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    write('.gitignore', 'dist/\n')
    write('src/a.ts', 'const needle = 1\nconst other = 2\nconst Needle = 3\n', 1_000_000)
    write('src/b.ts', 'needle()\n', 2_000_000)
    write('src/c.py', 'needle = None\n', 1_500_000)
    write('dist/bundle.js', 'needle needle needle\n')
    write('.github/workflow.yml', 'needle: true\n')
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const rg = () => new Ripgrep(binary!)

  it('按内容搜：认忽略规则、搜隐藏目录、带上下文', async () => {
    const result = await rg().searchContent({ cwd: root, pattern: 'needle', maxMatches: 50, contextLines: 1 })
    const paths = result.files.map(f => f.path).sort()
    expect(paths).toEqual(['.github/workflow.yml', 'src/a.ts', 'src/b.ts', 'src/c.py'].map(p => p.split('/').join(path.sep)))
    const a = result.files.find(f => f.path.endsWith('a.ts'))!
    expect(a.lines.filter(l => l.isMatch).map(l => l.line)).toEqual([1, 3])
    expect(a.lines.some(l => !l.isMatch && l.line === 2)).toBe(true)
    expect(result.matchCount).toBe(5)
    expect(result.truncated).toBe(false)
  })

  it('全小写时不分大小写，指定区分就只命中原样', async () => {
    const smart = await rg().searchContent({ cwd: root, pattern: 'needle', maxMatches: 50, globs: ['*.ts'] })
    expect(smart.matchCount).toBe(3)
    const exact = await rg().searchContent({ cwd: root, pattern: 'needle', maxMatches: 50, globs: ['*.ts'], caseSensitive: true })
    expect(exact.matchCount).toBe(2)
  })

  it('命中超过上限就截断', async () => {
    const result = await rg().searchContent({ cwd: root, pattern: 'needle', maxMatches: 2 })
    expect(result.matchCount).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('按文件类型筛', async () => {
    const result = await rg().filesWithMatches({ cwd: root, pattern: 'needle', fileType: 'py' }, 10)
    expect(result.paths).toEqual([path.join('src', 'c.py')])
  })

  it('只看文件时最近改过的排前面', async () => {
    const result = await rg().filesWithMatches({ cwd: root, pattern: 'needle', paths: ['src'] }, 10)
    expect(result.paths).toEqual(['b.ts', 'c.py', 'a.ts'].map(f => path.join('src', f)))
  })

  it('计数多的在前', async () => {
    const result = await rg().countMatches({ cwd: root, pattern: 'needle', globs: ['*.ts'] }, 10)
    expect(result.counts[0]).toEqual({ path: path.join('src', 'a.ts'), count: 2 })
    expect(result.total).toBe(2)
  })

  it('按模式找文件：认忽略规则、按修改时间倒序、有上限', async () => {
    const all = await rg().listFiles({ cwd: root, globs: ['*.ts', '*.js'] }, 10)
    expect(all.paths).toEqual([path.join('src', 'b.ts'), path.join('src', 'a.ts')])
    const capped = await rg().listFiles({ cwd: root, globs: ['src/**'] }, 1)
    expect(capped.paths).toEqual([path.join('src', 'b.ts')])
    expect(capped.total).toBe(3)
    expect(capped.truncated).toBe(true)
  })

  it('正则写错时报 ripgrep 的原话', async () => {
    await expect(rg().searchContent({ cwd: root, pattern: 'foo(', maxMatches: 10 })).rejects.toBeInstanceOf(RipgrepError)
  })

  it('没命中返回空，不算出错', async () => {
    const result = await rg().searchContent({ cwd: root, pattern: 'zzz_not_here', maxMatches: 10 })
    expect(result.files).toEqual([])
  })
})
