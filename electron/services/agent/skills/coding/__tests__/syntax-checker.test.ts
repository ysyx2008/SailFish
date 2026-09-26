import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }))

import { SyntaxChecker } from '../syntax-checker'
import { SyntaxGuard } from '../syntax-guard'

const checker = new SyntaxChecker()

const VALID: Record<string, string> = {
  'a.js': 'const f = (x) => <div>{x}</div>\nexport default f\n',
  'a.ts': 'type A<T> = { a: T }\nexport const x: A<number> = { a: 1 } satisfies A<number>\n',
  'a.tsx': 'export const C = ({ n }: { n: number }) => <span>{n}</span>\n',
  'a.py': 'def f(x: int) -> int:\n    match x:\n        case 1:\n            return 2\n    return x\n',
  'a.go': 'package main\n\nfunc main() {\n\tfor i := range 10 {\n\t\t_ = i\n\t}\n}\n',
  'A.java': 'public class A {\n  record P(int x) {}\n  void f() { var p = new P(1); }\n}\n',
  'a.cs': 'namespace N;\npublic record P(int X);\npublic class A { void F() { var p = new P(1); } }\n',
  'a.c': '#include <stdio.h>\nint main(void) { printf("hi\\n"); return 0; }\n',
  'a.cpp': '#include <vector>\nauto f() { std::vector<int> v{1, 2}; return v; }\n',
  'a.rs': 'fn main() {\n    let v: Vec<i32> = (0..3).collect();\n    println!("{:?}", v);\n}\n',
}

describe('SyntaxChecker', () => {
  it.each(Object.entries(VALID))('%s 正常代码不报错', async (file, code) => {
    expect(await checker.findIssues(file, code)).toEqual([])
  })

  it('认不出的语言不查', async () => {
    expect(checker.supports('a.md')).toBe(false)
    expect(await checker.findIssues('a.md', '# x')).toBeUndefined()
  })

  it('改出来的错误会报，带行号和那一行', async () => {
    const before = 'function f() {\n  return 1\n}\n'
    const after = 'function f() {\n  return (1\n}\n'
    const issues = await checker.newIssues('a.js', before, after)
    expect(issues?.length).toBeGreaterThan(0)
    expect(issues![0].line).toBeGreaterThanOrEqual(2)
  })

  it('原本就有的错误不报，哪怕行号挪了', async () => {
    const before = 'def ok():\n    return 1\n\ndef bad(:\n    pass\n'
    const after = '# 加一行注释\n' + before
    expect(await checker.newIssues('a.py', before, after)).toEqual([])
  })

  it('新文件（改前为空）里的错误都算新的', async () => {
    const issues = await checker.newIssues('a.go', '', 'package main\nfunc main() {\n')
    expect(issues?.length).toBeGreaterThan(0)
  })
})

describe('SyntaxGuard', () => {
  let dir: string
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-guard-')) })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const guard = new SyntaxGuard(checker)
  const ctx = { data: {}, resolveLocalPath: (p: string) => path.resolve(dir, p) }

  it('改坏了在结果后面提示，修改照样写入', async () => {
    const file = path.join(dir, 'a.ts')
    fs.writeFileSync(file, 'export const a = 1\n')
    const result = await guard.wrap({ name: 'edit_file', args: { path: 'a.ts' } }, async () => {
      fs.writeFileSync(file, 'export const a = {\n')
      return { success: true, output: 'ok' }
    }, ctx)
    expect(result.success).toBe(true)
    expect(result.output.startsWith('ok\n\n')).toBe(true)
    expect(result.output.length).toBeGreaterThan(4)
    expect(fs.readFileSync(file, 'utf8')).toBe('export const a = {\n')
  })

  it('改好了不加任何提示；不是改文件的工具不插手', async () => {
    const file = path.join(dir, 'b.ts')
    fs.writeFileSync(file, 'export const b = 1\n')
    const ok = await guard.wrap({ name: 'code_multi_edit', args: { path: file } }, async () => {
      fs.writeFileSync(file, 'export const b = 2\n')
      return { success: true, output: 'ok' }
    }, ctx)
    expect(ok.output).toBe('ok')
    const other = await guard.wrap({ name: 'read_file', args: { path: 'nope.ts' } }, async () => ({ success: true, output: 'r' }), ctx)
    expect(other.output).toBe('r')
  })

  it('修改失败时原样返回', async () => {
    const result = await guard.wrap({ name: 'write_text_file', args: { path: 'c.ts' } }, async () => ({ success: false, output: '', error: 'x' }), ctx)
    expect(result).toEqual({ success: false, output: '', error: 'x' })
  })
})
