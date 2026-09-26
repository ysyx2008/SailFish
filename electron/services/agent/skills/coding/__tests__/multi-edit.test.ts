import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-ud-'))
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => userData } }))

import { executeCodingTool } from '../executor'
import type { AgentConfig, ToolExecutorConfig } from '../../../tools/types'

let dir: string
let file: string

function makeExecutor(): ToolExecutorConfig {
  return {
    addStep: vi.fn((s: object) => ({ ...s, id: 's', timestamp: 0 })),
    updateStep: vi.fn(),
    waitForConfirmation: vi.fn(async () => true),
  } as unknown as ToolExecutorConfig
}

const config = { executionMode: 'free' } as AgentConfig

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-'))
  file = path.join(dir, 'a.ts')
  fs.writeFileSync(file, 'const a = 1\nconst b = 2\nconst c = 3\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const run = (args: Record<string, unknown>) =>
  executeCodingTool('code_multi_edit', '', { path: file, ...args }, 'c1', config, makeExecutor())

describe('code_multi_edit', () => {
  it('按顺序全部改上', async () => {
    const result = await run({
      edits: [
        { old_text: 'const a = 1', new_text: 'const a = 10' },
        { old_text: 'const a = 10\nconst b = 2', new_text: 'const a = 10\nconst b = 20' },
        { old_text: 'const', new_text: 'let', replace_all: true },
      ],
    })
    expect(result.success).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('let a = 10\nlet b = 20\nlet c = 3\n')
  })

  it('有一处找不到就整次不改，并说是第几处', async () => {
    const result = await run({
      edits: [
        { old_text: 'const a = 1', new_text: 'const a = 10' },
        { old_text: 'const z = 9', new_text: 'x' },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('2')
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\nconst b = 2\nconst c = 3\n')
  })

  it('有一处匹配多处就整次不改', async () => {
    const result = await run({ edits: [{ old_text: 'const', new_text: 'let' }] })
    expect(result.success).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('const a = 1\nconst b = 2\nconst c = 3\n')
  })

  it('edits 缺了或格式不对要说清', async () => {
    expect((await run({ edits: [] })).success).toBe(false)
    expect((await run({ edits: [{ old_text: 'x' }] })).success).toBe(false)
  })

  it('文件不存在不新建', async () => {
    const result = await executeCodingTool('code_multi_edit', '', { path: path.join(dir, 'nope.ts'), edits: [{ old_text: 'a', new_text: 'b' }] }, 'c1', config, makeExecutor())
    expect(result.success).toBe(false)
    expect(fs.existsSync(path.join(dir, 'nope.ts'))).toBe(false)
  })
})
